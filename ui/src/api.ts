import type { QueueStats, DlqPage } from './types.js';

export class ApiError extends Error {
  readonly problemType?: string;

  constructor(
    public readonly status: number,
    message: string,
    problemType?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    if (problemType !== undefined) this.problemType = problemType;
  }
}

type Problem = { type?: string; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Best-effort read of an RFC 9457 problem+json error body; never throws. */
async function readProblem(res: Response): Promise<Problem> {
  try {
    const body: unknown = await res.json();
    if (!isRecord(body)) return {};
    const problem: Problem = {};
    if (typeof body['type'] === 'string') problem.type = body['type'];
    if (typeof body['detail'] === 'string') problem.detail = body['detail'];
    return problem;
  } catch {
    return {};
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  // The dashboard reads and requeues; it never calls a worker endpoint, so it sends no
  // X-Worker-Id (SPEC §9) — it is not a worker.
  const res = await fetch(path, init);
  if (!res.ok) {
    const problem = await readProblem(res);
    throw new ApiError(
      res.status,
      problem.detail ?? `${init.method ?? 'GET'} ${path} → ${res.status}`,
      problem.type,
    );
  }
  return res;
}

// The one place wire JSON is asserted rather than validated: the API is same-repo and its
// response types are mirrored from the backend. Isolating the assertion here keeps every call
// site cast-free.
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function listQueues(): Promise<string[]> {
  const body = await readJson<{ queues: string[] }>(await req('/queues'));
  return body.queues;
}

export async function getStats(name: string): Promise<QueueStats> {
  return readJson<QueueStats>(await req(`/queues/${encodeURIComponent(name)}/stats`));
}

export async function listDlq(name: string): Promise<DlqPage> {
  return readJson<DlqPage>(await req(`/queues/${encodeURIComponent(name)}/dlq?limit=50`));
}

export async function requeue(id: string): Promise<void> {
  await req(`/tasks/${encodeURIComponent(id)}/requeue`, { method: 'POST' });
}
