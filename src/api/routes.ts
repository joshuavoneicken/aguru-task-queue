import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { taskIdSchema } from '../domain/task.js';
import { decodeCursor } from '../domain/cursor.js';
import { store } from '../store/contract.js';
import { enqueueBody, claimBodyFor, ackBody, nackBody, extendBody, queueName } from './validation.js';
import { problem } from './problem.js';

const dlqQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
}).strict();

// The onRequest guard in server.ts already rejected requests without a valid header; this
// re-read exists so the routes take the worker identity from a string, not a cast.
function headerWorkerId(req: FastifyRequest): string | null {
  const value = req.headers['x-worker-id'];
  return typeof value === 'string' ? value : null;
}

type NamedQueue = { Params: { name: string } };
type SingleTask = { Params: { id: string } };

export function registerRoutes(app: FastifyInstance, pool: pg.Pool, config: ApiConfig): void {
  const claimBody = claimBodyFor(config.claimMaxLimit);

  app.post<NamedQueue>('/queues/:name/tasks', async (req, reply) => {
    const name = queueName.safeParse(req.params.name);
    if (!name.success) return problem(reply, 'validation', 'queue name must match [A-Za-z0-9._-]{1,128}');
    const parsed = enqueueBody.safeParse(req.body);
    if (!parsed.success) return problem(reply, 'validation', parsed.error.message);
    await store.ensureQueue(pool, name.data, config.defaultQueuePolicy);
    const { id, created } = await store.enqueue(pool, name.data, {
      type: parsed.data.type, payload: parsed.data.payload,
      ...(parsed.data.delay !== undefined ? { delayMs: parsed.data.delay } : {}),
      ...(parsed.data.dedupeKey !== undefined ? { dedupeKey: parsed.data.dedupeKey } : {}),
    });
    return reply.status(created ? 201 : 200).send({ id });
  });

  app.post<NamedQueue>('/queues/:name/claim', async (req, reply) => {
    const name = queueName.safeParse(req.params.name);
    if (!name.success) return problem(reply, 'validation', 'queue name must match [A-Za-z0-9._-]{1,128}');
    const parsed = claimBody.safeParse(req.body);
    if (!parsed.success) return problem(reply, 'validation', parsed.error.message);
    const workerId = headerWorkerId(req);
    if (workerId === null) return problem(reply, 'missing-worker-id', 'X-Worker-Id header is required');
    if (parsed.data.workerId !== workerId) {
      return problem(reply, 'validation', 'workerId disagrees with X-Worker-Id');
    }
    const rows = await store.claim(pool, name.data, workerId, parsed.data.max, config.leaseMs);
    return reply.send({
      tasks: rows.map(({ leaseExpiresAt, ...task }) => ({ ...task, leaseUntil: leaseExpiresAt.toISOString() })),
      leaseUntil: rows[0]?.leaseExpiresAt.toISOString() ?? null,
    });
  });

  app.post<SingleTask>('/tasks/:id/ack', async (req, reply) => {
    const id = taskIdSchema.safeParse(req.params.id);
    if (!id.success) return problem(reply, 'validation', 'task id must be a UUID');
    const parsed = ackBody.safeParse(req.body ?? {});
    if (!parsed.success) return problem(reply, 'validation', parsed.error.message);
    const workerId = headerWorkerId(req);
    if (workerId === null) return problem(reply, 'missing-worker-id', 'X-Worker-Id header is required');
    // Refused before the store sees it: an oversized result is terminal for the task (§8), and
    // the caller — not the queue — owns that verdict, so nothing is persisted here.
    if (Buffer.byteLength(JSON.stringify(parsed.data.result ?? null)) > config.resultMaxBytes) {
      return problem(reply, 'payload-too-large', `result exceeds the ${config.resultMaxBytes}-byte stored-result cap`);
    }
    const acked = await store.ack(pool, id.data, workerId, parsed.data.result ?? null, parsed.data.claimId);
    if (!acked) return problem(reply, 'lost-lease', 'task is not in flight under this worker and claim');
    return reply.status(204).send();
  });

  app.post<SingleTask>('/tasks/:id/nack', async (req, reply) => {
    const id = taskIdSchema.safeParse(req.params.id);
    if (!id.success) return problem(reply, 'validation', 'task id must be a UUID');
    const parsed = nackBody.safeParse(req.body);
    if (!parsed.success) return problem(reply, 'validation', parsed.error.message);
    const workerId = headerWorkerId(req);
    if (workerId === null) return problem(reply, 'missing-worker-id', 'X-Worker-Id header is required');
    const b = parsed.data;
    // A body without a kind still gets §6's taxonomy: derived from the flags (SPEC §8, A17).
    const kind = b.kind ?? (b.forgiveAttempt === true ? 'worker_shutdown' : b.retryable ? 'handler_error' : 'handler_terminal');
    const nacked = await store.nack(pool, id.data, workerId, {
      reason: b.reason, retryable: b.retryable, kind,
      ...(b.forgiveAttempt !== undefined ? { forgiveAttempt: b.forgiveAttempt } : {}),
      ...(b.claimId !== undefined ? { claimId: b.claimId } : {}),
    });
    if (!nacked) return problem(reply, 'lost-lease', 'task is not in flight under this worker and claim');
    return reply.status(204).send();
  });

  app.post<SingleTask>('/tasks/:id/extend', async (req, reply) => {
    const id = taskIdSchema.safeParse(req.params.id);
    if (!id.success) return problem(reply, 'validation', 'task id must be a UUID');
    const parsed = extendBody.safeParse(req.body);
    if (!parsed.success) return problem(reply, 'validation', parsed.error.message);
    const workerId = headerWorkerId(req);
    if (workerId === null) return problem(reply, 'missing-worker-id', 'X-Worker-Id header is required');
    if (parsed.data.workerId !== workerId) {
      return problem(reply, 'validation', 'workerId disagrees with X-Worker-Id');
    }
    const leaseUntil = await store.extend(
      pool, id.data, workerId, config.leaseMs, config.maxTaskExecutionMs, parsed.data.claimId,
    );
    if (leaseUntil === null) return problem(reply, 'lost-lease', 'task is not in flight under this worker and claim');
    return reply.send({ leaseUntil: leaseUntil.toISOString() });
  });

  app.post<SingleTask>('/tasks/:id/requeue', async (req, reply) => {
    const id = taskIdSchema.safeParse(req.params.id);
    if (!id.success) return problem(reply, 'validation', 'task id must be a UUID');
    const outcome = await store.requeue(pool, id.data);
    if (outcome === 'not_found') return problem(reply, 'not-found', 'no such task');
    if (outcome === 'not_in_dlq') return problem(reply, 'not-in-dlq', 'only DLQ tasks can be requeued');
    return reply.status(204).send();
  });

  app.get<SingleTask>('/tasks/:id', async (req, reply) => {
    const id = taskIdSchema.safeParse(req.params.id);
    if (!id.success) return problem(reply, 'validation', 'task id must be a UUID');
    const task = await store.getTask(pool, id.data);
    if (task === null) return problem(reply, 'not-found', 'no such task');
    return reply.send(task);
  });

  app.get('/queues', async (_req, reply) => {
    const queues = await store.listQueues(pool);
    return reply.send({ queues });
  });

  app.get<NamedQueue>('/queues/:name/stats', async (req, reply) => {
    const name = queueName.safeParse(req.params.name);
    if (!name.success) return problem(reply, 'validation', 'queue name must match [A-Za-z0-9._-]{1,128}');
    const stats = await store.getStats(pool, name.data);
    if (stats === null) return problem(reply, 'not-found', 'no such queue');
    return reply.send(stats);
  });

  app.get<NamedQueue>('/queues/:name/dlq', async (req, reply) => {
    const name = queueName.safeParse(req.params.name);
    if (!name.success) return problem(reply, 'validation', 'queue name must match [A-Za-z0-9._-]{1,128}');
    const parsed = dlqQuery.safeParse(req.query);
    if (!parsed.success) return problem(reply, 'validation', parsed.error.message);
    const cursor = parsed.data.cursor !== undefined ? decodeCursor(parsed.data.cursor) : undefined;
    if (cursor === null) return problem(reply, 'validation', 'cursor is not a valid page token');
    const page = await store.listDlq(pool, name.data, parsed.data.limit, cursor);
    if (page === null) return problem(reply, 'not-found', 'no such queue');
    return reply.send(page);
  });
}
