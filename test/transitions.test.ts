import { describe, expect, it } from 'vitest';
import { withDb } from './helpers/db.js';
import { ack, claim, extend, getTask, nack, requeue } from '../src/store/tasks.js';
import { enqueue } from './helpers/enqueue.js';
import type { ClaimedRow } from '../src/store/tasks.js';
import { claimIdSchema, taskIdSchema } from '../src/domain/task.js';
import type pg from 'pg';

// A well-formed UUID the store never issued: a stale fence or an unknown task, depending on use.
const STALE_CLAIM = claimIdSchema.parse('00000000-0000-4000-8000-000000000000');
const UNKNOWN_TASK = taskIdSchema.parse('00000000-0000-4000-8000-000000000000');

async function claimed(pool: pg.Pool, queue = 'q'): Promise<ClaimedRow> {
  await enqueue(pool, queue, { type: 'js', payload: {} });
  const [t] = await claim(pool, queue, 'w1', 1, 30_000);
  if (t === undefined) throw new Error('nothing claimed');
  return t;
}

describe('ack', () => {
  it('succeeds for the owner with the right fence and stores the result', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      expect(await ack(pool, t.id, 'w1', { value: 42 }, t.claimId)).toBe(true);
      const rec = await getTask(pool, t.id);
      expect(rec).toMatchObject({ state: 'succeeded', result: { value: 42 } });
    });
  });

  it('refuses a stale claim id, the wrong worker, and a second ack', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      expect(await ack(pool, t.id, 'thief', {}, t.claimId)).toBe(false);
      expect(await ack(pool, t.id, 'w1', {}, STALE_CLAIM)).toBe(false);
      expect(await ack(pool, t.id, 'w1', {}, t.claimId)).toBe(true);
      expect(await ack(pool, t.id, 'w1', {}, t.claimId)).toBe(false); // not idempotent, §8
    });
  });

  it('omitted claimId falls back to the worker-only match (A20)', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      expect(await ack(pool, t.id, 'w1', {})).toBe(true);
    });
  });
});

describe('nack', () => {
  it('retryable with attempts left: ready with backoff, kind and reason recorded', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      expect(await nack(pool, t.id, 'w1', { reason: '503', retryable: true, kind: 'handler_error', claimId: t.claimId })).toBe(true);
      const { rows } = await pool.query(
        `SELECT status, failure_kind, last_error, run_after > now() AS backed_off,
                worker_id, claim_id FROM tasks WHERE id = $1`, [t.id]);
      expect(rows[0]).toMatchObject({ status: 'ready', failure_kind: 'handler_error', last_error: '503',
        backed_off: true, worker_id: null, claim_id: null });
    });
  });

  it('terminal: dlq immediately regardless of attempts remaining', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await nack(pool, t.id, 'w1', { reason: 'SyntaxError', retryable: false, kind: 'handler_terminal', claimId: t.claimId });
      expect((await getTask(pool, t.id))?.state).toBe('dlq');
    });
  });

  it('retryable with attempts exhausted: dlq', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await pool.query('UPDATE tasks SET attempts = max_attempts WHERE id = $1', [t.id]);
      await nack(pool, t.id, 'w1', { reason: '503', retryable: true, kind: 'handler_error', claimId: t.claimId });
      expect((await getTask(pool, t.id))?.state).toBe('dlq');
    });
  });

  it('forgiving: attempt refunded, forgiveness counted, ready with no backoff', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await nack(pool, t.id, 'w1', { reason: 'drain', retryable: true, kind: 'worker_shutdown', forgiveAttempt: true, claimId: t.claimId });
      const { rows } = await pool.query(
        'SELECT status, attempts, attempts_forgiven, run_after <= now() AS immediate FROM tasks WHERE id = $1', [t.id]);
      expect(rows[0]).toMatchObject({ status: 'ready', attempts: 0, attempts_forgiven: 1, immediate: true });
    });
  });

  it('at the forgiveness cap a forgiving nack degrades to a counted one (§4)', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await pool.query('UPDATE tasks SET attempts_forgiven = max_attempts WHERE id = $1', [t.id]);
      await nack(pool, t.id, 'w1', { reason: 'drain', retryable: true, kind: 'worker_shutdown', forgiveAttempt: true, claimId: t.claimId });
      const { rows } = await pool.query('SELECT attempts, attempts_forgiven, status FROM tasks WHERE id = $1', [t.id]);
      expect(rows[0]).toMatchObject({ attempts: 1, attempts_forgiven: 5, status: 'ready' });
    });
  });

  it('refuses a stale fence', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      expect(await nack(pool, t.id, 'w1', { reason: 'x', retryable: true, kind: 'handler_error', claimId: STALE_CLAIM })).toBe(false);
    });
  });
});

describe('extend', () => {
  it('renews for the owner, refuses everyone and everything else', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      const renewed = await extend(pool, t.id, 'w1', 30_000, 300_000, t.claimId);
      expect(renewed?.getTime()).toBeGreaterThan(t.leaseExpiresAt.getTime() - 1000);
      expect(await extend(pool, t.id, 'thief', 30_000, 300_000, t.claimId)).toBeNull();
    });
  });

  it('renews a lapsed-but-unreclaimed lease (§3: CAS on ownership, not punctuality)', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1`, [t.id]);
      expect(await extend(pool, t.id, 'w1', 30_000, 300_000, t.claimId)).not.toBeNull();
    });
  });

  it('refuses renewal past the execution budget (§3 backstop)', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await pool.query(`UPDATE tasks SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [t.id]);
      expect(await extend(pool, t.id, 'w1', 30_000, 300_000, t.claimId)).toBeNull();
    });
  });
});

describe('requeue', () => {
  it('resets attempts, forgiveness and failure columns; only from dlq', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await pool.query('UPDATE tasks SET attempts_forgiven = 2 WHERE id = $1', [t.id]);
      await nack(pool, t.id, 'w1', { reason: 'x', retryable: false, kind: 'handler_terminal', claimId: t.claimId });
      expect(await requeue(pool, t.id)).toBe('ok');
      const { rows } = await pool.query(
        'SELECT status, attempts, attempts_forgiven, failed_at, failure_kind, last_error FROM tasks WHERE id = $1', [t.id]);
      expect(rows[0]).toMatchObject({ status: 'ready', attempts: 0, attempts_forgiven: 0,
        failed_at: null, failure_kind: null, last_error: null });
      expect(await requeue(pool, t.id)).toBe('not_in_dlq');
      expect(await requeue(pool, UNKNOWN_TASK)).toBe('not_found');
    });
  });
});

describe('getTask', () => {
  it('reports effective state and never exposes fence columns', async () => {
    await withDb(async (pool) => {
      const t = await claimed(pool);
      await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
      const rec = await getTask(pool, t.id);
      expect(rec?.state).toBe('ready'); // effective state from the view, not the raw column
      expect(rec !== null && 'claimId' in rec).toBe(false);
      expect(rec !== null && 'workerId' in rec).toBe(false);
    });
  });
});
