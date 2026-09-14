import { describe, expect, it } from 'vitest';
import { withDb } from './helpers/db.js';
import { claim } from '../src/store/tasks.js';
import { enqueue } from './helpers/enqueue.js';
import { drainExpired, reapExpired } from '../src/store/reaper.js';
import type pg from 'pg';

async function expire(pool: pg.Pool): Promise<void> {
  await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE status = 'in_flight'`);
}

describe('reapExpired', () => {
  it('returns an expired lease to ready with backoff, clearing every claim column', async () => {
    await withDb(async (pool) => {
      const { id } = await enqueue(pool, 'q', { type: 'js', payload: {} });
      await claim(pool, 'q', 'w1', 1, 30_000);
      await expire(pool);
      expect(await reapExpired(pool, 100)).toMatchObject({ requeued: 1, deadLettered: 0 });
      const { rows } = await pool.query(
        `SELECT status, worker_id, claim_id, claimed_at, lease_expires_at, last_error, failure_kind,
                run_after > now() AS backed_off FROM tasks WHERE id = $1`, [id]);
      expect(rows[0]).toMatchObject({ status: 'ready', worker_id: null, claim_id: null,
        claimed_at: null, lease_expires_at: null, last_error: 'lease expired', failure_kind: 'lease_expired',
        backed_off: true });
    });
  });

  it('dead-letters an expired lease with attempts exhausted', async () => {
    await withDb(async (pool) => {
      const { id } = await enqueue(pool, 'q', { type: 'js', payload: {} });
      await claim(pool, 'q', 'w1', 1, 30_000);
      await pool.query('UPDATE tasks SET attempts = max_attempts WHERE id = $1', [id]);
      await expire(pool);
      expect(await reapExpired(pool, 100)).toMatchObject({ requeued: 0, deadLettered: 1 });
      const { rows } = await pool.query(
        'SELECT status, failure_kind, failed_at FROM tasks WHERE id = $1', [id]);
      expect(rows[0]).toMatchObject({ status: 'dlq', failure_kind: 'lease_expired' });
      expect(rows[0].failed_at).not.toBeNull();
    });
  });

  it('leaves live leases alone', async () => {
    await withDb(async (pool) => {
      await enqueue(pool, 'q', { type: 'js', payload: {} });
      await claim(pool, 'q', 'w1', 1, 30_000);
      expect(await reapExpired(pool, 100)).toMatchObject({ requeued: 0, deadLettered: 0 });
    });
  });

  it('releases expired dedupe keys and leaves live ones', async () => {
    await withDb(async (pool) => {
      await enqueue(pool, 'q', { type: 'js', payload: {}, dedupeKey: 'old' });
      await enqueue(pool, 'q', { type: 'js', payload: {}, dedupeKey: 'live' });
      await pool.query(`UPDATE tasks SET dedupe_expires_at = now() - interval '1 second' WHERE dedupe_key = 'old'`);
      expect(await reapExpired(pool, 100)).toMatchObject({ dedupeReleased: 1 });
      const { rows } = await pool.query('SELECT dedupe_key FROM tasks ORDER BY dedupe_key NULLS FIRST');
      expect(rows.map((r) => r.dedupe_key)).toEqual([null, 'live']);
    });
  });

  it('concurrent reapers partition the work — every task recovered exactly once', async () => {
    await withDb(async (pool) => {
      await Promise.all(Array.from({ length: 40 }, () => enqueue(pool, 'q', { type: 'js', payload: {} })));
      await claim(pool, 'q', 'w1', 40, 30_000);
      await expire(pool);
      const results = await Promise.all(Array.from({ length: 4 }, () => reapExpired(pool, 20)));
      expect(results.reduce((n, r) => n + r.requeued, 0)).toBe(40);
    });
  });

  it('drainExpired clears a mass death bigger than one batch', async () => {
    await withDb(async (pool) => {
      await Promise.all(Array.from({ length: 25 }, () => enqueue(pool, 'q', { type: 'js', payload: {} })));
      await claim(pool, 'q', 'w1', 25, 30_000);
      await expire(pool);
      expect((await drainExpired(pool, 10)).requeued).toBe(25);
    });
  });

  it('drainExpired rejects a batch below 1 — a LIMIT 0 pass would never terminate', { timeout: 2000 }, async () => {
    await withDb(async (pool) => {
      await expect(drainExpired(pool, 0)).rejects.toThrow('batch must be >= 1');
    });
  });
});
