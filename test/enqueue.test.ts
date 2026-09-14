import { describe, expect, it } from 'vitest';
import { withDb } from './helpers/db.js';
import { enqueue as storeEnqueue } from '../src/store/tasks.js';
import { ensureQueue, listQueues, seedQueues } from '../src/store/queues.js';
import { enqueue, TEST_POLICY } from './helpers/enqueue.js';

describe('enqueue', () => {
  it('creates a ready task copying the queue policy onto the row', async () => {
    await withDb(async (pool) => {
      await seedQueues(pool, [{ name: 'q', maxAttempts: 3, backoffBaseMs: 500, backoffCapMs: 60_000, dedupeWindowMs: 600_000 }]);
      const { id, created } = await enqueue(pool, 'q', { type: 'js', payload: { source: '1' } });
      expect(created).toBe(true);
      const { rows } = await pool.query(
        'SELECT status, attempts, max_attempts, backoff_base_ms FROM tasks WHERE id = $1', [id]);
      expect(rows[0]).toMatchObject({ status: 'ready', attempts: 0, max_attempts: 3, backoff_base_ms: 500 });
    });
  });

  it('ensureQueue creates a queue with the given policy and never overwrites an existing one (A7)', async () => {
    await withDb(async (pool) => {
      await ensureQueue(pool, 'fresh', { maxAttempts: 2, backoffBaseMs: 100, backoffCapMs: 1000, dedupeWindowMs: 5000 });
      await ensureQueue(pool, 'fresh', TEST_POLICY);
      expect(await listQueues(pool)).toContain('fresh');
      const { rows } = await pool.query('SELECT max_attempts, backoff_base_ms, backoff_cap_ms, dedupe_window_ms FROM queues WHERE name = $1', ['fresh']);
      expect(rows[0]).toEqual({ max_attempts: 2, backoff_base_ms: 100, backoff_cap_ms: 1000, dedupe_window_ms: 5000 });
    });
  });

  it('enqueue into a queue that does not exist fails rather than inventing a policy', async () => {
    await withDb(async (pool) => {
      await expect(storeEnqueue(pool, 'nowhere', { type: 'js', payload: {} })).rejects.toThrow(/nowhere/);
    });
  });

  it('the schema refuses a queue row without a policy — defaults are application config, not DDL', async () => {
    await withDb(async (pool) => {
      await expect(pool.query('INSERT INTO queues (name) VALUES ($1)', ['bare'])).rejects.toThrow(/not-null/);
    });
  });

  it('applies delayMs to run_after', async () => {
    await withDb(async (pool) => {
      const { id } = await enqueue(pool, 'q', { type: 'js', payload: {}, delayMs: 60_000 });
      const { rows } = await pool.query<{ future: boolean }>(
        `SELECT run_after > now() + interval '30 seconds' AS future FROM tasks WHERE id = $1`, [id]);
      expect(rows[0]?.future).toBe(true);
    });
  });

  it('collapses two enqueues sharing a dedupeKey to one task, same id, created flags 201/200', async () => {
    await withDb(async (pool) => {
      const a = await enqueue(pool, 'q', { type: 'js', payload: {}, dedupeKey: 'k' });
      const b = await enqueue(pool, 'q', { type: 'js', payload: { other: true }, dedupeKey: 'k' });
      expect(b.id).toBe(a.id);
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
    });
  });

  it('dedupes across states — a succeeded task still holds its key until the window lapses (§7)', async () => {
    await withDb(async (pool) => {
      const a = await enqueue(pool, 'q', { type: 'js', payload: {}, dedupeKey: 'k' });
      await pool.query(`UPDATE tasks SET status = 'succeeded', succeeded_at = now() WHERE id = $1`, [a.id]);
      const b = await enqueue(pool, 'q', { type: 'js', payload: {}, dedupeKey: 'k' });
      expect(b.id).toBe(a.id);
      expect(b.created).toBe(false);
    });
  });

  it('same key in different queues does not collide', async () => {
    await withDb(async (pool) => {
      const a = await enqueue(pool, 'q1', { type: 'js', payload: {}, dedupeKey: 'k' });
      const b = await enqueue(pool, 'q2', { type: 'js', payload: {}, dedupeKey: 'k' });
      expect(b.id).not.toBe(a.id);
    });
  });

  it('ten simultaneous same-key enqueues return one id', async () => {
    await withDb(async (pool) => {
      await ensureQueue(pool, 'q', TEST_POLICY);
      const results = await Promise.all(Array.from({ length: 10 }, () =>
        enqueue(pool, 'q', { type: 'js', payload: {}, dedupeKey: 'burst' })));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });
  });
});
