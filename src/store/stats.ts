import type pg from 'pg';
import { queueExists } from './queues.js';

export interface QueueStats { ready: number; inFlight: number; dlq: number }

// Each subquery is served by a partial index; the in-flight scans are bounded by fleet
// concurrency (SPEC §3's HOT trade). The expiry arithmetic mirrors the task_state view
// exactly — the equivalence is a named invariant, held by test/stats-dlq.test.ts.
const STATS = `
  SELECT
    (SELECT count(*) FROM tasks WHERE queue_name = $1 AND status = 'ready')
    + (SELECT count(*) FROM tasks WHERE queue_name = $1 AND status = 'in_flight'
        AND lease_expires_at <= now() AND attempts < max_attempts)              AS ready,
    (SELECT count(*) FROM tasks WHERE queue_name = $1 AND status = 'in_flight'
        AND lease_expires_at > now())                                           AS in_flight,
    (SELECT count(*) FROM tasks WHERE queue_name = $1 AND status = 'dlq')
    + (SELECT count(*) FROM tasks WHERE queue_name = $1 AND status = 'in_flight'
        AND lease_expires_at <= now() AND attempts >= max_attempts)             AS dlq`;

export async function getStats(pool: pg.Pool, queue: string): Promise<QueueStats | null> {
  if (!(await queueExists(pool, queue))) return null;
  const { rows } = await pool.query<{ ready: string; in_flight: string; dlq: string }>(STATS, [queue]);
  const r = rows[0];
  if (r === undefined) return null;
  return { ready: Number(r.ready), inFlight: Number(r.in_flight), dlq: Number(r.dlq) };
}
