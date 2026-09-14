import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { z } from 'zod';
import { classifyUnknown } from '../src/domain/failure.js';
import { taskIdSchema, type ClaimId, type TaskId } from '../src/domain/task.js';
import { classifyJsError, createJsHandler } from '../src/handlers/js.js';
import { drainExpired, reapExpired } from '../src/store/reaper.js';
import { ensureQueue } from '../src/store/queues.js';
import { claim as storeClaim, enqueue as storeEnqueue, extend as storeExtend } from '../src/store/tasks.js';
import {
  Harness, HandlerRegistry, IdleBackoff, createLifecycle, systemClock,
  type ClaimedTask, type Classifier, type Clock, type Handler,
} from '@aguru/harness';
import { ManualClock } from '@aguru/harness/manual-clock';
import { HttpQueueClient } from '../src/http-queue-client.js';
import { withDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';

// The named failure-model invariants of SPEC §10, exercised end to end: real API, real harness,
// real Postgres time. Leases are genuinely short (1500ms) rather than mocked, because now() is
// Postgres's; the grace must sit under the lease for config to load at all.
const SHORT_LEASE = { LEASE_MS: '1500', SHUTDOWN_GRACE_MS: '1000' };
const LEASE_MS = 1_500;

const enqueueResponse = z.object({ id: taskIdSchema });

/** A queue whose backoff is near-zero, so a retried task is claimable again within milliseconds. */
async function createQueue(
  pool: pg.Pool, name: string, policy: { maxAttempts: number; backoffBaseMs: number; backoffCapMs: number },
): Promise<void> {
  await ensureQueue(pool, name, { ...policy, dedupeWindowMs: 600_000 });
}

async function enqueueTask(baseUrl: string, queue: string, type: string, payload: unknown): Promise<TaskId> {
  const res = await fetch(`${baseUrl}/queues/${queue}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-id': 'producer' },
    body: JSON.stringify({ type, payload }),
  });
  expect(res.status).toBe(201);
  return enqueueResponse.parse(await res.json()).id;
}

interface TaskRow {
  status: string;
  attempts: number;
  attempts_forgiven: number;
  failure_kind: string | null;
  worker_id: string | null;
  claim_id: string | null;
}

async function taskRow(pool: pg.Pool, id: TaskId): Promise<TaskRow> {
  const { rows } = await pool.query<TaskRow>(
    'SELECT status, attempts, attempts_forgiven, failure_kind, worker_id, claim_id FROM tasks WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`task ${id} vanished`);
  return row;
}

async function expireLease(pool: pg.Pool, id: TaskId): Promise<void> {
  await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(probe: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const neverResolves: Handler = () => new Promise<never>(() => {});

/** Claims one task, riding out the near-zero retry backoff a re-readied task may still be under. */
async function claimOne(client: HttpQueueClient, queue: string): Promise<ClaimedTask> {
  let claimed: ClaimedTask | undefined;
  await until(async () => {
    [claimed] = await client.claim(queue, 1);
    return claimed !== undefined;
  }, `a claim on ${queue} to return a task`);
  if (claimed === undefined) throw new Error('unreachable: until() returned without a claim');
  return claimed;
}

function llmHarness(
  baseUrl: string, workerId: string, queue: string, handler: Handler,
  options: { clock?: Clock; classifier?: Classifier } = {},
): { harness: Harness; client: HttpQueueClient } {
  const client = new HttpQueueClient(baseUrl, workerId);
  const registry = new HandlerRegistry().register('llm', handler, options.classifier ?? classifyUnknown);
  const harness = new Harness({
    client,
    registry,
    queueName: queue,
    concurrency: 1,
    leaseMs: LEASE_MS,
    maxTaskExecutionMs: 60_000,
    clock: options.clock ?? systemClock,
    idleBackoff: new IdleBackoff(() => 0.2), // deterministic short idle sleeps: nothing waits close to the cap
  });
  return { harness, client };
}

describe('failure-model invariants (SPEC §10), end to end', () => {
  it("a dead worker's task recovers automatically: the expired lease re-readies it and a second worker completes it, attempts = 2", async () => {
    await withServer(async ({ baseUrl, pool }) => {
      await createQueue(pool, 'recovery', { maxAttempts: 5, backoffBaseMs: 25, backoffCapMs: 100 });
      const id = await enqueueTask(baseUrl, 'recovery', 'llm', { model: 'm', prompt: 'p' });

      // Worker A claims and then dies mid-task: its handler never settles, and its clock never
      // advances, so the heartbeat never renews — exactly a process that froze after claiming.
      const dead = llmHarness(baseUrl, 'wA', 'recovery', neverResolves, { clock: new ManualClock() });
      dead.harness.start();
      await until(async () => (await taskRow(pool, id)).status === 'in_flight', 'worker A to claim');
      expect((await taskRow(pool, id)).attempts).toBe(1);

      // The lease expires on Postgres's clock; the reaper (driven directly) re-readies the task.
      await until(async () => {
        await drainExpired(pool, 100);
        return (await taskRow(pool, id)).status === 'ready';
      }, 'the expired lease to be reaped');
      const recovered = await taskRow(pool, id);
      expect(recovered).toMatchObject({ attempts: 1, worker_id: null, claim_id: null });

      const second = llmHarness(baseUrl, 'wB', 'recovery', async () => ({ recoveredBy: 'wB' }));
      second.harness.start();
      await until(async () => (await taskRow(pool, id)).status === 'succeeded', 'worker B to complete the task');
      await second.harness.stop();

      // Two deliveries, one per worker: at-least-once, with the dead attempt counted.
      expect((await taskRow(pool, id)).attempts).toBe(2);
    }, SHORT_LEASE);
  });

  it("a stale execution cannot ack: after expiry and re-claim by the same worker, the old claim's ack is refused", async () => {
    await withServer(async ({ baseUrl, pool }) => {
      await createQueue(pool, 'fence', { maxAttempts: 5, backoffBaseMs: 25, backoffCapMs: 100 });
      const id = await enqueueTask(baseUrl, 'fence', 'llm', { model: 'm', prompt: 'p' });
      const client = new HttpQueueClient(baseUrl, 'w1');

      const [first] = await client.claim('fence', 1);
      expect(first).toBeDefined();

      // The worker stalls past its lease; the reaper hands the task back.
      await expireLease(pool, id);
      await drainExpired(pool, 100);

      // The SAME worker claims it again — the fence must be the claim id, not the worker id.
      const second = await claimOne(client, 'fence');
      expect(second.claimId).not.toBe(first!.claimId);

      // The stale execution wakes up and tries to report success: refused (409 -> false).
      expect(await client.ack(id, { from: 'the stale claim' }, first!.claimId)).toBe(false);
      expect(await taskRow(pool, id)).toMatchObject({
        status: 'in_flight', worker_id: 'w1', claim_id: second.claimId,
      });

      // The live claim is untouched by the refusal: its own ack still lands.
      expect(await client.ack(id, { from: 'the live claim' }, second.claimId)).toBe(true);
      expect((await taskRow(pool, id)).status).toBe('succeeded');
    }, SHORT_LEASE);
  });

  it('a terminal failure lands in the DLQ immediately: handler_terminal on the first attempt, no retries', async () => {
    await withServer(async ({ baseUrl, pool }) => {
      await createQueue(pool, 'terminal', { maxAttempts: 5, backoffBaseMs: 25, backoffCapMs: 100 });
      const id = await enqueueTask(baseUrl, 'terminal', 'js', { source: 'return ((' });

      // The real js handler: the hostile source dies in its forked child with a SyntaxError,
      // which the classifier rules terminal — retrying a broken script cannot help.
      const client = new HttpQueueClient(baseUrl, 'wA');
      const registry = new HandlerRegistry().register('js', createJsHandler({ defaultTimeoutMs: 10_000 }), classifyJsError);
      const harness = new Harness({
        client, registry, queueName: 'terminal', concurrency: 1, leaseMs: LEASE_MS,
        maxTaskExecutionMs: 60_000, clock: systemClock, idleBackoff: new IdleBackoff(() => 0.2),
      });
      harness.start();
      await until(async () => (await taskRow(pool, id)).status === 'dlq', 'the task to dead-letter');
      await harness.stop();

      expect(await taskRow(pool, id)).toMatchObject({
        status: 'dlq', attempts: 1, failure_kind: 'handler_terminal',
      });

      // And the wire agrees: the DLQ page carries it, the stats count it.
      const statsRes = await fetch(`${baseUrl}/queues/terminal/stats`, { headers: { 'x-worker-id': 'observer' } });
      expect(await statsRes.json()).toMatchObject({ ready: 0, inFlight: 0, dlq: 1 });
    }, SHORT_LEASE);
  });

  it('a graceful drain forgives: the interrupted attempt is handed back, then the task completes elsewhere', async () => {
    await withServer(async ({ baseUrl, pool }) => {
      await createQueue(pool, 'drain', { maxAttempts: 5, backoffBaseMs: 25, backoffCapMs: 100 });
      const id = await enqueueTask(baseUrl, 'drain', 'llm', { model: 'm', prompt: 'p' });

      // Worker A is mid-task when the deployment SIGTERMs it; its handler outlives any grace.
      const first = llmHarness(baseUrl, 'wA', 'drain', neverResolves);
      first.harness.start();
      await until(async () => (await taskRow(pool, id)).status === 'in_flight', 'worker A to claim');

      const exits: number[] = [];
      let drain: Promise<void> | undefined;
      const lifecycle = createLifecycle({
        harness: {
          stop: () => {
            drain = first.harness.stop();
            return drain;
          },
          heldTasks: () => first.harness.heldTasks(),
        },
        client: first.client,
        shutdownGraceMs: 250,
        onExit: (code) => exits.push(code),
      });
      await lifecycle.shutdown();
      expect(exits).toEqual([0]);

      // The blameless release: re-ready NOW (no backoff wait), the attempt handed back.
      expect(await taskRow(pool, id)).toMatchObject({
        status: 'ready', attempts: 0, attempts_forgiven: 1,
        failure_kind: 'worker_shutdown', worker_id: null, claim_id: null,
      });

      // The abandoned drain settles once A's heartbeat discovers the lease is gone.
      expect(drain).toBeDefined();
      await drain;

      const second = llmHarness(baseUrl, 'wB', 'drain', async () => ({ finishedBy: 'wB' }));
      second.harness.start();
      await until(async () => (await taskRow(pool, id)).status === 'succeeded', 'worker B to complete the task');
      await second.harness.stop();

      // One real attempt on the books; the interruption cost the task nothing.
      expect(await taskRow(pool, id)).toMatchObject({ attempts: 1, attempts_forgiven: 1 });
    }, SHORT_LEASE);
  });

  it('attempts are bounded including forgiveness: the cap degrades forgiving nacks, then exhaustion dead-letters within 2 x max_attempts cycles', async () => {
    await withServer(async ({ baseUrl, pool }) => {
      const maxAttempts = 3;
      await createQueue(pool, 'bounded', { maxAttempts, backoffBaseMs: 1, backoffCapMs: 2 });
      const id = await enqueueTask(baseUrl, 'bounded', 'llm', { model: 'm', prompt: 'p' });
      const client = new HttpQueueClient(baseUrl, 'w1');

      // Phase 1 — a worker that is endlessly "shutting down": each cycle claims and hands the
      // attempt back, until the attempts_forgiven CHECK cap degrades the forgiveness to a counted
      // nack. Without the cap this loop would spin forever; that is the regression under test.
      let cycles = 0;
      for (;;) {
        cycles += 1;
        expect(cycles, 'forgiveness must degrade at the cap').toBeLessThanOrEqual(maxAttempts + 1);
        const task = await claimOne(client, 'bounded');
        expect(await client.nack(task.id, {
          reason: 'worker shutting down', retryable: true, kind: 'worker_shutdown',
          forgiveAttempt: true, claimId: task.claimId,
        })).toBe(true);
        const row = await taskRow(pool, id);
        if (row.attempts > 0) {
          // Degraded: the forgiveness budget is spent and this nack was counted.
          expect(row).toMatchObject({ attempts: 1, attempts_forgiven: maxAttempts, status: 'ready' });
          break;
        }
        expect(row).toMatchObject({ attempts: 0, attempts_forgiven: cycles });
      }

      // Phase 2 — plain retryable failures to exhaustion.
      while ((await taskRow(pool, id)).status !== 'dlq') {
        cycles += 1;
        expect(cycles, 'exhaustion must dead-letter within 2 x max_attempts cycles').toBeLessThanOrEqual(maxAttempts * 2);
        const task = await claimOne(client, 'bounded');
        expect(await client.nack(task.id, {
          reason: 'upstream 503', retryable: true, kind: 'handler_error', claimId: task.claimId,
        })).toBe(true);
      }

      // Bounded overall: max_attempts forgiven cycles + max_attempts counted ones, and not one more.
      expect(cycles).toBe(maxAttempts * 2);
      expect(await taskRow(pool, id)).toMatchObject({
        status: 'dlq', attempts: maxAttempts, attempts_forgiven: maxAttempts,
      });
    }, SHORT_LEASE);
  });

  // Store-level on purpose: the race is between two SQL statements on one row, and driving both
  // through the pool is the only way to make them genuinely concurrent.
  it('a heartbeat racing the reaper leaves exactly one owner: renewed-and-in-flight or reaped-and-ready, never both, never neither', async () => {
    await withDb(async (pool) => {
      // Enough attempts that 20 losing rounds never exhaust the task mid-test.
      await createQueue(pool, 'race', { maxAttempts: 50, backoffBaseMs: 1, backoffCapMs: 1 });
      const { id } = await storeEnqueue(pool, 'race', { type: 'llm', payload: {} });

      const claimAgain = async (): Promise<ClaimId> => {
        let claimId: ClaimId | undefined;
        await until(async () => {
          claimId = (await storeClaim(pool, 'race', 'w1', 1, 30_000))[0]?.claimId;
          return claimId !== undefined;
        }, 'the re-readied task to be claimable');
        if (claimId === undefined) throw new Error('unreachable: until() returned without a claim');
        return claimId;
      };

      let claimId = await claimAgain();
      for (let round = 0; round < 20; round += 1) {
        await expireLease(pool, id);
        const [renewed] = await Promise.all([
          storeExtend(pool, id, 'w1', 30_000, 300_000, claimId),
          reapExpired(pool, 10),
        ]);
        const row = await taskRow(pool, id);
        if (renewed !== null) {
          // The heartbeat won: still in flight, still w1's, under the same claim.
          expect(row, `round ${round}`).toMatchObject({ status: 'in_flight', worker_id: 'w1', claim_id: claimId });
        } else {
          // The reaper won: back to ready with no owner — and the refused renewal told w1 so.
          expect(row, `round ${round}`).toMatchObject({ status: 'ready', worker_id: null, claim_id: null });
          claimId = await claimAgain();
        }
      }
    });
  });
});
