import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withDb } from './helpers/db.js';
import { ack, claim, nack, requeue } from '../src/store/tasks.js';
import { enqueue } from './helpers/enqueue.js';
import { getStats } from '../src/store/stats.js';
import { listDlq } from '../src/store/dlq.js';
import { decodeCursor } from '../src/domain/cursor.js';
import type { TaskId } from '../src/domain/task.js';

describe('getStats', () => {
  it('partitions ready / inFlight / dlq exactly as the task_state view', async () => {
    await withDb(async (pool) => {
      // Succeeded history — must appear in no bucket.
      await enqueue(pool, 'q', { type: 'js', payload: {} });
      const [done] = await claim(pool, 'q', 'w1', 1, 30_000);
      await ack(pool, done!.id, 'w1', { ok: true }, done!.claimId);

      // Expired-exhausted in_flight — counts dlq before the reaper stamps failed_at.
      await enqueue(pool, 'q', { type: 'js', payload: {} });
      const [exhausted] = await claim(pool, 'q', 'w1', 1, 30_000);
      await pool.query(
        `UPDATE tasks SET lease_expires_at = now() - interval '1 minute', attempts = max_attempts WHERE id = $1`,
        [exhausted!.id]);

      await enqueue(pool, 'q', { type: 'js', payload: {} });                       // ready
      await enqueue(pool, 'q', { type: 'js', payload: {}, delayMs: 60_000 });      // ready (delayed, A18)
      await enqueue(pool, 'q', { type: 'js', payload: {} });                       // -> in_flight
      await enqueue(pool, 'q', { type: 'js', payload: {} });                       // -> expired in_flight
      await enqueue(pool, 'q', { type: 'js', payload: {} });                       // -> dlq
      const claimedTasks = await claim(pool, 'q', 'w1', 3, 30_000);
      const [, expired, dead] = claimedTasks;
      await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [expired!.id]);
      await nack(pool, dead!.id, 'w1', { reason: 'x', retryable: false, kind: 'handler_terminal', claimId: dead!.claimId });

      const stats = await getStats(pool, 'q');
      // Expired-but-unreaped with attempts left counts ready; expired-exhausted counts dlq.
      expect(stats).toEqual({ ready: 3, inFlight: 1, dlq: 2 });

      const view = await pool.query<{ state: string; n: string }>(
        `SELECT state, count(*) AS n FROM task_state WHERE queue_name = 'q' GROUP BY state`);
      const byState = Object.fromEntries(view.rows.map((r) => [r.state, Number(r.n)]));
      expect(stats).toEqual({ ready: byState.ready ?? 0, inFlight: byState.in_flight ?? 0, dlq: byState.dlq ?? 0 });
    });
  });

  it('returns null for an unknown queue', async () => {
    await withDb(async (pool) => {
      expect(await getStats(pool, 'nope')).toBeNull();
    });
  });
});

async function deadLetter(pool: pg.Pool, queue: string, i: number): Promise<TaskId> {
  const { id } = await enqueue(pool, queue, { type: 'js', payload: { i } });
  const [t] = await claim(pool, queue, 'w1', 1, 30_000);
  await nack(pool, id, 'w1', { reason: `err${i}`, retryable: false, kind: 'handler_terminal', claimId: t!.claimId });
  return id;
}

describe('listDlq', () => {
  it('pages by keyset, newest failures first, stable under requeue-while-reading', async () => {
    await withDb(async (pool) => {
      const ids: TaskId[] = [];
      for (let i = 0; i < 5; i++) ids.push(await deadLetter(pool, 'q', i));

      const page1 = await listDlq(pool, 'q', 2);
      expect(page1!.tasks.map((t) => t.id)).toEqual([ids[4], ids[3]]); // newest failures first
      expect(page1!.nextCursor).not.toBeNull();

      // The listing is a triage projection: payload and result must not be in it (SPEC §9) —
      // they carry code, prompts and credentials, and drill-in goes through GET /tasks/:id.
      const row = page1!.tasks[0]!;
      expect('payload' in row).toBe(false);
      expect('result' in row).toBe(false);
      expect(row).toMatchObject({
        queue: 'q', type: 'js', state: 'dlq', attempts: 1,
        failureKind: 'handler_terminal', lastError: 'err4',
      });
      expect(row.failedAt).toBeInstanceOf(Date);
      expect(row.createdAt).toBeInstanceOf(Date);

      // A page-1 row leaving the DLQ must not shift the keyset: no skip, no repeat behind it.
      await requeue(pool, ids[4]!);

      const page2 = await listDlq(pool, 'q', 2, decodeCursor(page1!.nextCursor!)!);
      expect(page2!.tasks.map((t) => t.id)).toEqual([ids[2], ids[1]]);
      const last = await listDlq(pool, 'q', 2, decodeCursor(page2!.nextCursor!)!);
      expect(last!.tasks.map((t) => t.id)).toEqual([ids[0]]);
      expect(last!.nextCursor).toBeNull();
    });
  });

  it('keeps microsecond precision across a page boundary', async () => {
    await withDb(async (pool) => {
      // The reaper stamps a whole DLQ batch with one now(), so rows differing only in
      // microseconds sit at page boundaries; a millisecond-floored cursor would skip them.
      const older = await deadLetter(pool, 'q', 0);
      const newer = await deadLetter(pool, 'q', 1);
      await pool.query(`UPDATE tasks SET failed_at = '2026-01-01T00:00:00.123456Z' WHERE id = $1`, [older]);
      await pool.query(`UPDATE tasks SET failed_at = '2026-01-01T00:00:00.123999Z' WHERE id = $1`, [newer]);

      const page1 = await listDlq(pool, 'q', 1);
      expect(page1!.tasks.map((t) => t.id)).toEqual([newer]);
      const page2 = await listDlq(pool, 'q', 1, decodeCursor(page1!.nextCursor!)!);
      expect(page2!.tasks.map((t) => t.id)).toEqual([older]);
    });
  });

  it('returns null for an unknown queue and empty for a clean one', async () => {
    await withDb(async (pool) => {
      await enqueue(pool, 'q', { type: 'js', payload: {} });
      expect(await listDlq(pool, 'nope', 10)).toBeNull();
      expect(await listDlq(pool, 'q', 10)).toEqual({ tasks: [], nextCursor: null });
    });
  });
});
