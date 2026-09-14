import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://queue:queue@localhost:5432/queue' };

describe('loadApiConfig', () => {
  it('resolves defaults when only DATABASE_URL is set', () => {
    const c = loadApiConfig(base);
    expect(c).toMatchObject({
      port: 3000, leaseMs: 30_000,
      maxTaskExecutionMs: 300_000,
      payloadMaxBytes: 262_144, resultMaxBytes: 262_144,
      claimMaxLimit: 100,
    });
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.uiOrigin).toBe('http://localhost:5173');
  });

  it('throws a readable error without DATABASE_URL', () => {
    expect(() => loadApiConfig({})).toThrow(/DATABASE_URL/);
  });

  it('carries no worker-only settings', () => {
    const c = loadApiConfig(base);
    expect(c).not.toHaveProperty('concurrency');
    expect(c).not.toHaveProperty('workerId');
    expect(c).not.toHaveProperty('shutdownGraceMs');
  });

  it('reads numeric overrides', () => {
    const c = loadApiConfig({ ...base, LEASE_MS: '5000', CLAIM_MAX_LIMIT: '20' });
    expect(c.leaseMs).toBe(5000);
    expect(c.claimMaxLimit).toBe(20);
  });

  it('rejects a non-numeric override rather than silently defaulting', () => {
    expect(() => loadApiConfig({ ...base, LEASE_MS: 'soon' })).toThrow(/LEASE_MS/);
  });

  it('rejects a UI_ORIGIN that is not an http(s) URL — "*" must not become a wildcard CORS policy', () => {
    expect(() => loadApiConfig({ ...base, UI_ORIGIN: '*' })).toThrow(/UI_ORIGIN/);
    expect(() => loadApiConfig({ ...base, UI_ORIGIN: 'not a url' })).toThrow(/UI_ORIGIN/);
    expect(() => loadApiConfig({ ...base, UI_ORIGIN: 'file:///etc' })).toThrow(/UI_ORIGIN/);
    expect(loadApiConfig({ ...base, UI_ORIGIN: 'https://queue.example' }).uiOrigin).toBe('https://queue.example');
  });

  it('normalizes UI_ORIGIN to a bare origin — a trailing slash would never match a browser Origin header', () => {
    expect(loadApiConfig({ ...base, UI_ORIGIN: 'http://localhost:5173/' }).uiOrigin).toBe('http://localhost:5173');
    expect(loadApiConfig({ ...base, UI_ORIGIN: 'https://queue.example/app' }).uiOrigin).toBe('https://queue.example');
  });

  it('parses ALLOWED_HOSTS as a comma-separated hostname list, defaulting to none', () => {
    expect(loadApiConfig(base).allowedHosts).toEqual([]);
    expect(loadApiConfig({ ...base, ALLOWED_HOSTS: 'queue.internal,foo' }).allowedHosts).toEqual(['queue.internal', 'foo']);
    // Hostnames compare case-insensitively, so they normalise at the edge; stray commas are noise.
    expect(loadApiConfig({ ...base, ALLOWED_HOSTS: ' Queue.Internal ,, ' }).allowedHosts).toEqual(['queue.internal']);
  });

  it('resolves the default queue policy for implicitly created queues', () => {
    expect(loadApiConfig(base).defaultQueuePolicy).toEqual({
      maxAttempts: 5, backoffBaseMs: 3000, backoffCapMs: 300_000, dedupeWindowMs: 600_000,
    });
  });

  it('reads QUEUE_* overrides for the default queue policy', () => {
    const c = loadApiConfig({ ...base, QUEUE_MAX_ATTEMPTS: '2', QUEUE_BACKOFF_BASE_MS: '100', QUEUE_BACKOFF_CAP_MS: '1000', QUEUE_DEDUPE_WINDOW_MS: '5000' });
    expect(c.defaultQueuePolicy).toEqual({ maxAttempts: 2, backoffBaseMs: 100, backoffCapMs: 1000, dedupeWindowMs: 5000 });
  });

  it('rejects a default policy whose backoff cap is below its base', () => {
    expect(() => loadApiConfig({ ...base, QUEUE_BACKOFF_BASE_MS: '5000', QUEUE_BACKOFF_CAP_MS: '1000' })).toThrow(/backoffCapMs/);
  });

  it('loads and validates queue policies from QUEUES_FILE', () => {
    const c = loadApiConfig({ ...base, QUEUES_FILE: 'queues.json' });
    expect(c.queues[0]).toMatchObject({ name: 'jobs', maxAttempts: 5, backoffBaseMs: 3000 });
  });

  it('rejects a malformed queues file with a readable error', () => {
    expect(() => loadApiConfig({ ...base, QUEUES_FILE: 'package.json' })).toThrow(/queues/i);
  });
});

describe('loadWorkerConfig', () => {
  it('needs no DATABASE_URL: the worker is an HTTP client of the API (A9)', () => {
    const c = loadWorkerConfig({});
    expect(c).toMatchObject({ apiUrl: 'http://localhost:3000', queueName: 'jobs', concurrency: 4, leaseMs: 30_000, maxTaskExecutionMs: 300_000, shutdownGraceMs: 25_000, httpRedirectMax: 5, allowLoopbackHttp: false, resultMaxBytes: 262_144 });
    expect(c.workerId).toMatch(/^worker-/);
  });

  it('derives the default API URL from PORT and takes API_URL, QUEUE_NAME and WORKER_ID overrides', () => {
    expect(loadWorkerConfig({ PORT: '3100' }).apiUrl).toBe('http://localhost:3100');
    const c = loadWorkerConfig({ API_URL: 'http://api.internal:8080', QUEUE_NAME: 'emails', WORKER_ID: 'w-7' });
    expect(c).toMatchObject({ apiUrl: 'http://api.internal:8080', queueName: 'emails', workerId: 'w-7' });
  });

  it('rejects an API_URL that is not http(s)', () => {
    expect(() => loadWorkerConfig({ API_URL: 'ftp://x' })).toThrow(/API_URL/);
  });

  it('keeps an API_URL path prefix whole, dropping only a trailing slash — the client appends route paths to it', () => {
    expect(loadWorkerConfig({ API_URL: 'http://api.internal:8080/queue/' }).apiUrl).toBe('http://api.internal:8080/queue');
  });

  it('rejects an API_URL carrying a query or fragment — neither survives route composition', () => {
    expect(() => loadWorkerConfig({ API_URL: 'http://h:1/x?y=1' })).toThrow(/API_URL/);
  });

  it('enforces shutdownGraceMs < leaseMs: a lost drain must degrade to lease expiry', () => {
    expect(() => loadWorkerConfig({ SHUTDOWN_GRACE_MS: '30000' })).toThrow(/shutdownGraceMs/);
  });
});
