import { describe, expect, it } from 'vitest';
import { withDb } from './helpers/db.js';
import { claim } from '../src/store/tasks.js';
import { enqueue } from './helpers/enqueue.js';

describe('claim', () => {
  it('claims ready tasks: in_flight, fresh claim id, incremented attempts, lease set', async () => {
    await withDb(async (pool) => {
      const { id } = await enqueue(pool, 'q', { type: 'js', payload: {} });
      const [t] = await claim(pool, 'q', 'w1', 5, 30_000);
      expect(t).toMatchObject({ id, attempts: 1 });
      expect(t?.claimId).toMatch(/^[0-9a-f-]{36}$/);
      expect(t!.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    });
  });

  it('does not claim delayed tasks, in-flight tasks, or from other queues', async () => {
    await withDb(async (pool) => {
      await enqueue(pool, 'q', { type: 'js', payload: {}, delayMs: 60_000 });
      await enqueue(pool, 'other', { type: 'js', payload: {} });
      const { id } = await enqueue(pool, 'q', { type: 'js', payload: {} });
      const first = await claim(pool, 'q', 'w1', 10, 30_000);
      expect(first.map((t) => t.id)).toEqual([id]);
      expect(await claim(pool, 'q', 'w1', 10, 30_000)).toEqual([]);
    });
  });

  it('does not claim a task whose lease expired — the reaper owns recovery (§2)', async () => {
    await withDb(async (pool) => {
      await enqueue(pool, 'q', { type: 'js', payload: {} });
      await claim(pool, 'q', 'w1', 1, 30_000);
      await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 minute'`);
      expect(await claim(pool, 'q', 'w2', 10, 30_000)).toEqual([]);
    });
  });

  it('re-claim after requeue issues a different claim id', async () => {
    await withDb(async (pool) => {
      const { id } = await enqueue(pool, 'q', { type: 'js', payload: {} });
      const [a] = await claim(pool, 'q', 'w1', 1, 30_000);
      await pool.query(
        `UPDATE tasks SET status = 'ready', attempts = 0, worker_id = NULL, claim_id = NULL,
                          claimed_at = NULL, lease_expires_at = NULL WHERE id = $1`, [id]);
      const [b] = await claim(pool, 'q', 'w1', 1, 30_000);
      expect(b?.claimId).not.toBe(a?.claimId);
    });
  });

  it('never double-claims under 10 concurrent claimers (component-level smoke; the required test is Task 10)', async () => {
    await withDb(async (pool) => {
      await Promise.all(Array.from({ length: 60 }, (_, i) =>
        enqueue(pool, 'q', { type: 'js', payload: { i } })));
      const batches = await Promise.all(Array.from({ length: 10 }, (_, w) =>
        claim(pool, 'q', `w${w}`, 10, 30_000)));
      const ids = batches.flat().map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(60);
    });
  });
});
