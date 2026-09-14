import { describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import { z } from 'zod';
import { withServer } from './helpers/server.js';

// Every response body crosses this file as `unknown` and is narrowed exactly once, by a schema
// below — test bodies never cast what came off the wire.
const enqueued = z.object({ id: z.string() });
const claimedTask = z.object({ id: z.string(), claimId: z.string() });
const claimResponse = z.object({ tasks: z.array(claimedTask) });
const dlqPage = z.object({ tasks: z.array(z.record(z.unknown())) });
const queueList = z.object({ queues: z.array(z.string()) });
const problem = z.object({ type: z.string(), status: z.number(), detail: z.string() });
const record = z.record(z.unknown());

const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const OVERSIZED = 'x'.repeat(300_000); // past the 256KiB payload/result cap

interface CallResult {
  status: number;
  body: unknown;
}

async function call(baseUrl: string, method: string, path: string, body?: unknown): Promise<CallResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-worker-id': 'w1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed: unknown = text === '' ? null : JSON.parse(text);
  return { status: res.status, body: parsed };
}

async function enqueue(baseUrl: string, task: Record<string, unknown>): Promise<{ status: number; id: string }> {
  const res = await call(baseUrl, 'POST', '/queues/jobs/tasks', task);
  return { status: res.status, id: enqueued.parse(res.body).id };
}

/** Claims from 'jobs' expecting exactly one task back, with its fence. */
async function claimOne(baseUrl: string, max = 1): Promise<{ id: string; claimId: string }> {
  const res = await call(baseUrl, 'POST', '/queues/jobs/claim', { workerId: 'w1', max });
  expect(res.status).toBe(200);
  const { tasks } = claimResponse.parse(res.body);
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

describe('API', () => {
  it('enqueue -> claim -> ack -> GET /tasks/:id returns the stored result', async () => {
    await withServer(async ({ baseUrl }) => {
      const enq = await enqueue(baseUrl, { type: 'js', payload: { source: 'return 1' } });
      expect(enq.status).toBe(201);
      const task = await claimOne(baseUrl, 5);
      const ackRes = await call(baseUrl, 'POST', `/tasks/${task.id}/ack`, { result: { ok: true }, claimId: task.claimId });
      expect(ackRes.status).toBe(204);
      const got = await call(baseUrl, 'GET', `/tasks/${task.id}`);
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ state: 'succeeded', result: { ok: true } });
    });
  });

  it('deduplicated enqueue returns 200 with the same id (A6)', async () => {
    await withServer(async ({ baseUrl }) => {
      const first = await enqueue(baseUrl, { type: 'js', payload: { source: '1' }, dedupeKey: 'k' });
      const second = await enqueue(baseUrl, { type: 'js', payload: { source: '1' }, dedupeKey: 'k' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.id).toBe(first.id);
    });
  });

  it('a worker endpoint without the worker header gets 400', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/tasks/${UNKNOWN_UUID}/ack`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    });
  });

  it('enqueue and reads need no worker header', async () => {
    await withServer(async ({ baseUrl }) => {
      const enq = await fetch(`${baseUrl}/queues/jobs/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'js', payload: { source: '1' } }),
      });
      expect(enq.status).toBe(201);
      expect((await fetch(`${baseUrl}/queues`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/queues/jobs/stats`)).status).toBe(200);
    });
  });

  it('malformed JSON gets 400', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/queues/jobs/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-id': 'w1' },
        body: '{nope',
      });
      expect(res.status).toBe(400);
    });
  });

  it('an unknown body field gets 422 — the schemas are strict', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await call(baseUrl, 'POST', '/queues/jobs/tasks', { type: 'js', payload: { source: '1' }, priority: 1 });
      expect(res.status).toBe(422);
    });
  });

  it('an http task with a non-http url is 422 at enqueue, not a run-time dead letter', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await call(baseUrl, 'POST', '/queues/jobs/tasks', { type: 'http', payload: { method: 'GET', url: 'ftp://example.com/x' } });
      expect(res.status).toBe(422);
    });
  });

  it('an oversized payload gets 413', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await call(baseUrl, 'POST', '/queues/jobs/tasks', { type: 'js', payload: { source: OVERSIZED } });
      expect(res.status).toBe(413);
    });
  });

  it('nack: a forgive+terminal contradiction gets 422 leaving the claim usable; the default is retryable', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, { type: 'js', payload: { source: '1' } });
      const task = await claimOne(baseUrl);
      const contradiction = await call(baseUrl, 'POST', `/tasks/${task.id}/nack`, { reason: 'x', retryable: false, forgiveAttempt: true });
      expect(contradiction.status).toBe(422);
      const plain = await call(baseUrl, 'POST', `/tasks/${task.id}/nack`, { reason: 'blip', claimId: task.claimId });
      expect(plain.status).toBe(204);
      const got = await call(baseUrl, 'GET', `/tasks/${task.id}`);
      expect(got.body).toMatchObject({ state: 'ready' }); // retryable default: counted, backed off, not DLQ
    });
  });

  it('nack: a kind that disagrees with retryable gets 422 and leaves the claim usable', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, { type: 'js', payload: { source: '1' } });
      const task = await claimOne(baseUrl);
      const bad = await call(baseUrl, 'POST', `/tasks/${task.id}/nack`, { reason: 'x', kind: 'handler_terminal', retryable: true, claimId: task.claimId });
      expect(bad.status).toBe(422);
      const ok = await call(baseUrl, 'POST', `/tasks/${task.id}/nack`, { reason: 'x', kind: 'handler_terminal', retryable: false, claimId: task.claimId });
      expect(ok.status).toBe(204);
      const got = await call(baseUrl, 'GET', `/tasks/${task.id}`);
      expect(got.body).toMatchObject({ state: 'dlq', failureKind: 'handler_terminal' });
    });
  });

  it('an oversized ack result gets 413, and the still-claimed task can be nacked terminal to the DLQ', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, { type: 'js', payload: { source: '2' } });
      const task = await claimOne(baseUrl);
      const bigAck = await call(baseUrl, 'POST', `/tasks/${task.id}/ack`, { result: OVERSIZED, claimId: task.claimId });
      expect(bigAck.status).toBe(413);
      const term = await call(baseUrl, 'POST', `/tasks/${task.id}/nack`,
        { reason: 'result too large', retryable: false, kind: 'result_too_large', claimId: task.claimId });
      expect(term.status).toBe(204);
      expect((await call(baseUrl, 'GET', `/tasks/${task.id}`)).body).toMatchObject({ state: 'dlq' });
    });
  });

  it('claim with a body workerId that disagrees with X-Worker-Id gets 422, like extend', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, { type: 'js', payload: { source: '1' } });
      const res = await call(baseUrl, 'POST', '/queues/jobs/claim', { workerId: 'someone-else', max: 1 });
      expect(res.status).toBe(422);
      expect(problem.parse(res.body).detail).toMatch(/X-Worker-Id/);
      // Nothing was claimed under either identity.
      const stats = await call(baseUrl, 'GET', '/queues/jobs/stats');
      expect(stats.body).toMatchObject({ ready: 1, inFlight: 0 });
    });
  });

  it('claim max above the configured limit is 422, never silently clamped', async () => {
    await withServer(async ({ baseUrl }) => {
      for (let i = 0; i < 3; i++) await enqueue(baseUrl, { type: 'js', payload: { source: '1' } });
      const over = await call(baseUrl, 'POST', '/queues/jobs/claim', { workerId: 'w1', max: 3 });
      expect(over.status).toBe(422);
      const at = await call(baseUrl, 'POST', '/queues/jobs/claim', { workerId: 'w1', max: 2 });
      expect(at.status).toBe(200);
      expect(claimResponse.parse(at.body).tasks).toHaveLength(2);
    }, { CLAIM_MAX_LIMIT: '2' });
  });

  it('extend renews; a stale fence gets 409; a body/header worker mismatch gets 422', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, { type: 'js', payload: { source: '1' } });
      const task = await claimOne(baseUrl);
      const ok = await call(baseUrl, 'POST', `/tasks/${task.id}/extend`, { workerId: 'w1', claimId: task.claimId });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ leaseUntil: expect.any(String) });
      const mismatch = await call(baseUrl, 'POST', `/tasks/${task.id}/extend`, { workerId: 'w2', claimId: task.claimId });
      expect(mismatch.status).toBe(422);
      const stale = await call(baseUrl, 'POST', `/tasks/${task.id}/extend`, { workerId: 'w1', claimId: UNKNOWN_UUID });
      expect(stale.status).toBe(409);
    });
  });

  it('stats and the dlq page reflect a dead-lettered task; requeue replays it exactly once', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, { type: 'js', payload: { source: '1' } });
      const task = await claimOne(baseUrl);
      const dead = await call(baseUrl, 'POST', `/tasks/${task.id}/nack`, { reason: 'x', retryable: false, claimId: task.claimId });
      expect(dead.status).toBe(204);

      const stats = await call(baseUrl, 'GET', '/queues/jobs/stats');
      expect(stats.body).toEqual({ ready: 0, inFlight: 0, dlq: 1 });
      const dlq = await call(baseUrl, 'GET', '/queues/jobs/dlq?limit=10');
      const rows = dlqPage.parse(dlq.body).tasks;
      expect(rows).toHaveLength(1);
      // The exposure is closed on the wire: the listing every UI viewer receives carries
      // triage fields only — never the payload or stored result (SPEC §9).
      expect('payload' in rows[0]!).toBe(false);
      expect('result' in rows[0]!).toBe(false);
      expect(rows[0]).toMatchObject({ id: task.id, type: 'js', state: 'dlq', failureKind: 'handler_terminal' });

      expect((await call(baseUrl, 'POST', `/tasks/${task.id}/requeue`)).status).toBe(204);
      expect((await call(baseUrl, 'POST', `/tasks/${task.id}/requeue`)).status).toBe(409);
    });
  });

  it('an unknown queue: stats and dlq 404, but claim answers empty (§8: claim never 404s)', async () => {
    await withServer(async ({ baseUrl }) => {
      expect((await call(baseUrl, 'GET', '/queues/nope/stats')).status).toBe(404);
      expect((await call(baseUrl, 'GET', '/queues/nope/dlq')).status).toBe(404);
      const emptyClaim = await call(baseUrl, 'POST', '/queues/nope2/claim', { workerId: 'w1', max: 1 });
      expect(emptyClaim.status).toBe(200);
      expect(claimResponse.parse(emptyClaim.body).tasks).toEqual([]);
    });
  });

  it('lists queues for the queue-list view', async () => {
    await withServer(async ({ baseUrl }) => {
      await call(baseUrl, 'POST', '/queues/alpha/tasks', { type: 'js', payload: { source: '1' } });
      await call(baseUrl, 'POST', '/queues/beta/tasks', { type: 'js', payload: { source: '1' } });
      const res = await call(baseUrl, 'GET', '/queues');
      expect(res.status).toBe(200);
      const { queues } = queueList.parse(res.body);
      expect(queues).toEqual(expect.arrayContaining(['alpha', 'beta']));
    });
  });

  it('an implicitly created queue takes the configured default policy (A7)', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await call(baseUrl, 'POST', '/queues/fresh/tasks', { type: 'js', payload: { source: '1' } });
      expect(res.status).toBe(201);
      const claimed = await call(baseUrl, 'POST', '/queues/fresh/claim', { workerId: 'w1', max: 1 });
      const [task] = claimResponse.parse(claimed.body).tasks;
      if (task === undefined) throw new Error('expected one claimed task');
      await call(baseUrl, 'POST', `/tasks/${task.id}/nack`, { reason: 'blip', claimId: task.claimId });
      const got = await call(baseUrl, 'GET', `/tasks/${task.id}`);
      expect(got.body).toMatchObject({ state: 'dlq' }); // one attempt allowed, so a retryable nack still exhausts it
    }, { QUEUE_MAX_ATTEMPTS: '1' });
  });

  it('GET /queues needs no worker header', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/queues`);
      expect(res.status).toBe(200);
    });
  });

  it('claim response and reads never expose the fence or worker columns', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, { type: 'js', payload: { source: '1' } });
      const task = await claimOne(baseUrl); // the claimer gets the fence — claimOne's schema requires it...
      const got = record.parse((await call(baseUrl, 'GET', `/tasks/${task.id}`)).body);
      expect('claimId' in got).toBe(false); // ...readers never do (§8)
      expect('workerId' in got).toBe(false);
      expect('claim_id' in got).toBe(false);
    });
  });

  it('queue name is validated at the edge: overlong or bad charset gets 422 and persists nothing', async () => {
    await withServer(async ({ baseUrl, pool }) => {
      const overlong = 'q'.repeat(129);
      const long = await call(baseUrl, 'POST', `/queues/${overlong}/tasks`, { type: 'js', payload: { source: '1' } });
      expect(long.status).toBe(422);
      // %2F survives routing as one segment and URL-decodes to a slash — a charset the schema rejects
      const slash = await call(baseUrl, 'POST', '/queues/bad%2Fname/tasks', { type: 'js', payload: { source: '1' } });
      expect(slash.status).toBe(422);
      const { rowCount } = await pool.query('SELECT 1 FROM queues WHERE name IN ($1, $2)', [overlong, 'bad/name']);
      expect(rowCount).toBe(0);
    });
  });

  it('healthz reports the last reaper tick and needs no worker header', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      const body = record.parse(await res.json());
      expect(body.status).toBe('ok');
      expect('lastReaperTickAt' in body).toBe(true);
    });
  });

  it('answers CORS preflight from the configured UI origin', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/queues`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-worker-id',
        },
      });
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('x-worker-id');
    });
  });

  it('enforces the worker header on claim, ack, nack and extend', async () => {
    await withServer(async ({ baseUrl }) => {
      const claim = await fetch(`${baseUrl}/queues/jobs/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w1', max: 1 }),
      });
      expect(claim.status).toBe(400);
      for (const action of ['ack', 'nack', 'extend']) {
        const res = await fetch(`${baseUrl}/tasks/${UNKNOWN_UUID}/${action}`, { method: 'POST' });
        expect(res.status).toBe(400);
      }
    });
  });

  it('the worker guard matches the decoded route, not the raw url (no percent-encoding bypass)', async () => {
    await withServer(async ({ baseUrl }) => {
      // Fastify decodes %74asks -> tasks before routing; a guard on the raw url would let this
      // reach the ack handler unauthenticated. A read such as /%71ueues is unguarded (200).
      const ack = await fetch(`${baseUrl}/%74asks/${UNKNOWN_UUID}/ack`, { method: 'POST' });
      expect(ack.status).toBe(400);
      expect(ack.headers.get('content-type')).toContain('application/problem+json');
    });
  });

  it('never reflects a hostile origin in CORS headers', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/queues`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://evil.example',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-worker-id',
        },
      });
      const acao = res.headers.get('access-control-allow-origin');
      // The configured value or nothing — a reflect-any policy would echo the evil origin.
      expect(acao === 'http://localhost:5173' || acao === null).toBe(true);
      expect(acao).not.toBe('http://evil.example');
    });
  });

  // Host tests use undici.request: fetch treats Host as a forbidden header and silently drops
  // the override, so a forged-Host request cannot be built with it.
  it('rejects a forged Host header with a 400 problem before any handler runs', async () => {
    await withServer(async ({ baseUrl }) => {
      // A legitimate task establishes the queue, so "the forged request changed nothing"
      // is a positive assertion, not a 404 on a queue that was never created.
      await call(baseUrl, 'POST', '/queues/jobs/tasks', { type: 'js', payload: { source: '1' } });

      const rebound = await request(`${baseUrl}/healthz`, { headers: { host: 'evil.example' } });
      expect(rebound.statusCode).toBe(400);
      expect(rebound.headers['content-type']).toContain('application/problem+json');
      expect(problem.parse(await rebound.body.json())).toMatchObject({ type: '/problems/bad-host', status: 400 });
      // A valid worker header does not rescue it: the enqueue handler never runs.
      const api = await request(`${baseUrl}/queues/jobs/tasks`, {
        method: 'POST',
        headers: { host: 'evil.example:3000', 'x-worker-id': 'w1', 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'js', payload: { source: '1' } }),
      });
      expect(api.statusCode).toBe(400);
      expect(problem.parse(await api.body.json())).toMatchObject({ type: '/problems/bad-host' });
      const stats = await call(baseUrl, 'GET', '/queues/jobs/stats');
      expect(stats.body).toEqual({ ready: 1, inFlight: 0, dlq: 0 });
    });
  });

  it('accepts loopback Hosts in every spelling a local client sends', async () => {
    await withServer(async ({ baseUrl }) => {
      for (const host of ['localhost:3000', '127.0.0.1:5173', '[::1]:3000']) {
        const res = await request(`${baseUrl}/healthz`, { headers: { host } });
        expect(res.statusCode).toBe(200);
        await res.body.dump();
      }
    });
  });

  it('accepts a hostname configured via ALLOWED_HOSTS', async () => {
    await withServer(async ({ baseUrl }) => {
      const ok = await request(`${baseUrl}/healthz`, { headers: { host: 'queue.internal:8443' } });
      expect(ok.statusCode).toBe(200);
      await ok.body.dump();
      const other = await request(`${baseUrl}/healthz`, { headers: { host: 'other.internal' } });
      expect(other.statusCode).toBe(400);
      await other.body.dump();
    }, { ALLOWED_HOSTS: 'queue.internal' });
  });

  it('an unknown route gets the not-found problem, not the router default', async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/no/such/route`, { headers: { 'x-worker-id': 'w1' } });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(await res.json()).toMatchObject({ type: '/problems/not-found', status: 404 });
    });
  });

  // Deliberately last: each ends its own server's pool to force a store failure.
  it('a store failure surfaces as a problem+json 500 that leaks nothing internal', async () => {
    await withServer(async ({ baseUrl, pool }) => {
      // Muted, not asserted on: this test forces its own store failure before the server's
      // reaper has had a chance to stop, so an unrelated boot-tick failure can log here too.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await pool.end();
        const res = await fetch(`${baseUrl}/tasks/${UNKNOWN_UUID}`, { headers: { 'x-worker-id': 'w1' } });
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        const body = problem.parse(await res.json());
        expect(body).toMatchObject({ type: '/problems/internal', status: 500, detail: 'internal error' });
        expect(body.detail).not.toContain('pool');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('an internal failure is a static 500 problem to the caller and one log line naming the route, never the cause', async () => {
    await withServer(async ({ baseUrl, pool }) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await pool.end(); // every query now fails
        const res = await call(baseUrl, 'GET', '/queues/jobs/stats');
        expect(res.status).toBe(500);
        expect(problem.parse(res.body)).toMatchObject({ type: expect.stringContaining('internal'), detail: 'internal error' });
        // An unrelated reaper-tick failure may also log during this window; isolate this
        // request's own log line rather than assuming it is the only thing that logged.
        const requestLines = spy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('request failed'));
        expect(requestLines).toEqual([expect.stringMatching(/^request failed: GET \/queues\/:name\/stats Error$/)]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
