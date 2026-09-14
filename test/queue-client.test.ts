import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claimIdSchema, taskIdSchema } from '../src/domain/task.js';
import { ResultTooLargeError } from '@aguru/harness';
import { HttpQueueClient } from '../src/http-queue-client.js';
import { withServer } from './helpers/server.js';

const enqueueResponse = z.object({ id: taskIdSchema });
const taskRecord = z.object({
  state: z.enum(['ready', 'in_flight', 'succeeded', 'dlq']),
  attempts: z.number().int(),
  failureKind: z.string().nullable(),
  result: z.unknown(),
});

async function enqueue(baseUrl: string, queue: string, source: string) {
  const res = await fetch(`${baseUrl}/queues/${queue}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-id': 'producer' },
    body: JSON.stringify({ type: 'js', payload: { source } }),
  });
  expect(res.status).toBe(201);
  return enqueueResponse.parse(await res.json()).id;
}

async function getTask(baseUrl: string, id: string) {
  const res = await fetch(`${baseUrl}/tasks/${id}`, { headers: { 'x-worker-id': 'observer' } });
  expect(res.status).toBe(200);
  return taskRecord.parse(await res.json());
}

describe('HttpQueueClient', () => {
  it('claim maps the wire task onto ClaimedTask: branded ids, leaseUntil -> leaseExpiresAt', async () => {
    await withServer(async ({ baseUrl }) => {
      const id = await enqueue(baseUrl, 'jobs', 'return 1');
      const client = new HttpQueueClient(baseUrl, 'w1');
      const tasks = await client.claim('jobs', 5);
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      expect(task.id).toBe(id);
      expect(task.type).toBe('js');
      expect(task.payload).toEqual({ source: 'return 1' });
      expect(task.attempts).toBe(1);
      expect(claimIdSchema.safeParse(task.claimId).success).toBe(true);
      expect(task.leaseExpiresAt).toBe(new Date(task.leaseExpiresAt).toISOString());
      expect(new Date(task.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('ack returns true, then false once ownership is gone (409 -> false)', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, 'jobs', 'return 1');
      const client = new HttpQueueClient(baseUrl, 'w1');
      const [task] = await client.claim('jobs', 1);
      expect(await client.ack(task!.id, { ok: true }, task!.claimId)).toBe(true);
      expect(await client.ack(task!.id, { ok: true }, task!.claimId)).toBe(false);
      expect(await getTask(baseUrl, task!.id)).toMatchObject({ state: 'succeeded', result: { ok: true } });
    });
  });

  it('nack forwards retryable, kind and forgiveAttempt; a stale claim reports false', async () => {
    await withServer(async ({ baseUrl }) => {
      const client = new HttpQueueClient(baseUrl, 'w1');

      await enqueue(baseUrl, 'terminal', '1');
      const [t] = await client.claim('terminal', 1);
      expect(await client.nack(t!.id, {
        reason: 'bad syntax', retryable: false, kind: 'handler_terminal', claimId: t!.claimId,
      })).toBe(true);
      expect(await getTask(baseUrl, t!.id)).toMatchObject({ state: 'dlq', failureKind: 'handler_terminal' });

      await enqueue(baseUrl, 'flaky', '1');
      const [r] = await client.claim('flaky', 1);
      expect(await client.nack(r!.id, {
        reason: 'upstream 503', retryable: true, kind: 'handler_error', claimId: r!.claimId,
      })).toBe(true);
      // counted: the attempt stands
      expect(await getTask(baseUrl, r!.id)).toMatchObject({ state: 'ready', attempts: 1, failureKind: 'handler_error' });

      await enqueue(baseUrl, 'drained', '1');
      const [f] = await client.claim('drained', 1);
      expect(await client.nack(f!.id, {
        reason: 'worker shutdown', retryable: true, kind: 'worker_shutdown', forgiveAttempt: true, claimId: f!.claimId,
      })).toBe(true);
      // forgiven: the attempt is handed back
      expect(await getTask(baseUrl, f!.id)).toMatchObject({ state: 'ready', attempts: 0, failureKind: 'worker_shutdown' });

      expect(await client.nack(t!.id, {
        reason: 'stale', retryable: true, kind: 'handler_error', claimId: t!.claimId,
      })).toBe(false);
    });
  });

  it('extend returns the renewed lease and null once ownership is lost', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, 'jobs', '1');
      const client = new HttpQueueClient(baseUrl, 'w1');
      const [task] = await client.claim('jobs', 1);
      const renewed = await client.extend(task!.id, task!.claimId);
      expect(renewed).not.toBeNull();
      expect(new Date(renewed!).getTime()).toBeGreaterThanOrEqual(new Date(task!.leaseExpiresAt).getTime());
      await client.ack(task!.id, null, task!.claimId);
      expect(await client.extend(task!.id, task!.claimId)).toBeNull();
    });
  });

  it('an unreachable server rejects — transport trouble must never read as a refusal', async () => {
    const client = new HttpQueueClient('http://127.0.0.1:1', 'w1');
    const id = taskIdSchema.parse('00000000-0000-4000-8000-000000000001');
    const claimId = claimIdSchema.parse('00000000-0000-4000-8000-000000000002');
    await expect(client.claim('jobs', 1)).rejects.toThrow();
    await expect(client.ack(id, null, claimId)).rejects.toThrow();
    await expect(client.nack(id, { reason: 'x', retryable: true, kind: 'handler_error', claimId })).rejects.toThrow();
    await expect(client.extend(id, claimId)).rejects.toThrow();
  });

  it('a black-holed request rejects within the transport timeout — a hung call must throw, not wedge the loop', async () => {
    const server = createServer(() => { /* accept the request and never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
    const client = new HttpQueueClient(`http://127.0.0.1:${address.port}`, 'w1', { transportTimeoutMs: 250 });
    try {
      const startedAt = Date.now();
      await expect(client.claim('jobs', 1)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('an ack refused for result size throws ResultTooLargeError and leaves the task in flight', async () => {
    await withServer(async ({ baseUrl }) => {
      await enqueue(baseUrl, 'jobs', '1');
      const client = new HttpQueueClient(baseUrl, 'w1');
      const [task] = await client.claim('jobs', 1);
      // between resultMaxBytes (256KiB) and the server's body limit, so the route's check fires, not Fastify's
      await expect(client.ack(task!.id, 'x'.repeat(265_000), task!.claimId)).rejects.toBeInstanceOf(ResultTooLargeError);
      expect((await getTask(baseUrl, task!.id)).state).toBe('in_flight');
    });
  });
});
