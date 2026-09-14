import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const policyValuesShape = {
  maxAttempts: z.number().int().min(1),
  backoffBaseMs: z.number().int().positive(),
  backoffCapMs: z.number().int().positive(),
  dedupeWindowMs: z.number().int().positive(),
};
const capCoversBase = { message: 'backoffCapMs must be >= backoffBaseMs' };
const policyValuesSchema = z.object(policyValuesShape).strict()
  .refine((q) => q.backoffCapMs >= q.backoffBaseMs, capCoversBase);
const queuePolicySchema = z.object({ name: z.string().min(1).max(128), ...policyValuesShape }).strict()
  .refine((q) => q.backoffCapMs >= q.backoffBaseMs, capCoversBase);

const queuesFileSchema = z.array(queuePolicySchema);

export type QueuePolicyValues = z.infer<typeof policyValuesSchema>;
export type QueuePolicy = z.infer<typeof queuePolicySchema>;

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  queues: QueuePolicy[];
  defaultQueuePolicy: QueuePolicyValues;
  leaseMs: number;
  maxTaskExecutionMs: number;
  payloadMaxBytes: number;
  resultMaxBytes: number;
  claimMaxLimit: number;
  uiOrigin: string;
  allowedHosts: string[];
}

export interface WorkerConfig {
  apiUrl: string;
  queueName: string;
  workerId: string;
  concurrency: number;
  leaseMs: number;
  maxTaskExecutionMs: number;
  shutdownGraceMs: number;
  resultMaxBytes: number;
  httpRedirectMax: number;
  allowLoopbackHttp: boolean;
}

function httpOrigin(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  // Validated as a URL so '*' cannot silently become a wildcard CORS policy.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be an http(s) origin, got "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${key} must be an http(s) origin, got "${raw}"`);
  }
  // Normalised so a trailing slash or path cannot validate yet never match a browser Origin.
  return parsed.origin;
}

// The worker's target base URL. Validated as http(s) and kept whole: a path prefix here would be
// silently discarded by origin normalisation, so it is preserved (trailing slash removed) and the
// client appends route paths to it.
function httpBaseUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key] ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be an http(s) URL, got "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${key} must be an http(s) URL, got "${raw}"`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${key} must not carry a query or fragment, got "${raw}"`);
  }
  return parsed.href.replace(/\/+$/, '');
}

// Hostnames only — no scheme, no port. Lowercased here because hostnames compare
// case-insensitively and the Host guard matches by equality.
function hostList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (raw === undefined) return [];
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return value;
}

function loadQueues(env: NodeJS.ProcessEnv): QueuePolicy[] {
  const file = env.QUEUES_FILE;
  if (file === undefined) return [];
  const parsed = queuesFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`queues file ${file} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

// The policy a queue gets when first enqueue creates it implicitly (SPEC A7). A queue named in
// QUEUES_FILE takes the file's values instead; the schema itself carries no defaults.
function loadDefaultQueuePolicy(env: NodeJS.ProcessEnv): QueuePolicyValues {
  const parsed = policyValuesSchema.safeParse({
    maxAttempts: num(env, 'QUEUE_MAX_ATTEMPTS', 5),
    backoffBaseMs: num(env, 'QUEUE_BACKOFF_BASE_MS', 3_000),
    backoffCapMs: num(env, 'QUEUE_BACKOFF_CAP_MS', 300_000),
    dedupeWindowMs: num(env, 'QUEUE_DEDUPE_WINDOW_MS', 600_000),
  });
  if (!parsed.success) throw new Error(`default queue policy is invalid: ${parsed.error.message}`);
  return parsed.data;
}

// Settings both processes read. leaseMs must match on both sides (§3); the others bound the same
// values from each end (the API caps stored results, the http handler caps bodies at the same size).
function shared(env: NodeJS.ProcessEnv): Pick<ApiConfig, 'leaseMs' | 'maxTaskExecutionMs' | 'resultMaxBytes'> {
  return {
    leaseMs: num(env, 'LEASE_MS', 30_000),
    maxTaskExecutionMs: num(env, 'MAX_TASK_EXECUTION_MS', 300_000),
    resultMaxBytes: num(env, 'RESULT_MAX_BYTES', 262_144),
  };
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
  return {
    ...shared(env),
    port: num(env, 'PORT', 3000),
    databaseUrl,
    queues: loadQueues(env),
    defaultQueuePolicy: loadDefaultQueuePolicy(env),
    payloadMaxBytes: num(env, 'PAYLOAD_MAX_BYTES', 262_144),
    claimMaxLimit: num(env, 'CLAIM_MAX_LIMIT', 100),
    uiOrigin: httpOrigin(env, 'UI_ORIGIN', 'http://localhost:5173'),
    // Loopback is always accepted by the Host guard; this only adds public deployment names.
    allowedHosts: hostList(env, 'ALLOWED_HOSTS'),
  };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const common = shared(env);
  // The default grace tracks the lease (5/6 of it, capped at 25s) so that shortening
  // the lease alone cannot produce a contradictory pair; an explicitly set grace must
  // still fit inside the lease, because a lost drain degrades to lease expiry.
  const shutdownGraceMs = num(env, 'SHUTDOWN_GRACE_MS', Math.min(25_000, Math.floor((common.leaseMs * 5) / 6)));
  if (shutdownGraceMs >= common.leaseMs) {
    throw new Error(`shutdownGraceMs (${shutdownGraceMs}) must be < leaseMs (${common.leaseMs}): a lost drain must degrade to lease expiry`);
  }
  return {
    ...common,
    apiUrl: httpBaseUrl(env, 'API_URL', `http://localhost:${num(env, 'PORT', 3000)}`),
    queueName: env.QUEUE_NAME ?? 'jobs',
    workerId: env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
    concurrency: num(env, 'CONCURRENCY', 4),
    shutdownGraceMs,
    httpRedirectMax: num(env, 'HTTP_REDIRECT_MAX', 5),
    allowLoopbackHttp: env.ALLOW_LOOPBACK_HTTP === 'true',
  };
}
