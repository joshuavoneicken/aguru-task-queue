import type pg from 'pg';

export interface ReapResult { requeued: number; deadLettered: number; dedupeReleased: number }

// The two expiry statements partition expired in_flight rows exactly: attempts < max_attempts
// requeues, attempts >= max_attempts dead-letters. Each reuses claim's SKIP LOCKED + LIMIT shape
// so N concurrent reapers divide the backlog instead of contending. The requeue clears every
// claim column; the DLQ path keeps claimed_at to date the fatal attempt. failure_kind on the
// requeued row is provenance for triage ("this attempt died to lease expiry"), not a retryability
// verdict — the row is 'ready' regardless, same as any other requeue.
const REQUEUE_EXPIRED = `
  WITH expired AS (
    SELECT id FROM tasks
     WHERE status = 'in_flight' AND lease_expires_at <= now() AND attempts < max_attempts
     FOR UPDATE SKIP LOCKED LIMIT $1
  )
  UPDATE tasks t
     SET status = 'ready', worker_id = NULL, lease_expires_at = NULL,
         claim_id = NULL, claimed_at = NULL,
         last_error = 'lease expired', failure_kind = 'lease_expired',
         run_after = backoff_run_after(t.attempts, t.backoff_base_ms, t.backoff_cap_ms)
    FROM expired e WHERE t.id = e.id`;

const DLQ_EXHAUSTED = `
  WITH exhausted AS (
    SELECT id FROM tasks
     WHERE status = 'in_flight' AND lease_expires_at <= now() AND attempts >= max_attempts
     FOR UPDATE SKIP LOCKED LIMIT $1
  )
  UPDATE tasks t
     SET status = 'dlq', failed_at = now(), worker_id = NULL, lease_expires_at = NULL,
         claim_id = NULL,
         failure_kind = 'lease_expired', last_error = 'lease expired; attempts exhausted'
    FROM exhausted e WHERE t.id = e.id`;

const RELEASE_DEDUPE = `
  WITH released AS (
    SELECT id FROM tasks
     WHERE dedupe_key IS NOT NULL AND dedupe_expires_at <= now()
     FOR UPDATE SKIP LOCKED LIMIT $1
  )
  UPDATE tasks t SET dedupe_key = NULL, dedupe_expires_at = NULL
    FROM released r WHERE t.id = r.id`;

export async function reapExpired(pool: pg.Pool, limit: number): Promise<ReapResult> {
  const requeued = await pool.query(REQUEUE_EXPIRED, [limit]);
  const deadLettered = await pool.query(DLQ_EXHAUSTED, [limit]);
  const released = await pool.query(RELEASE_DEDUPE, [limit]);
  return {
    requeued: requeued.rowCount ?? 0,
    deadLettered: deadLettered.rowCount ?? 0,
    dedupeReleased: released.rowCount ?? 0,
  };
}

// Mass-death drain (SPEC §3): keep reaping until a pass comes back short on every front,
// which proves the backlog is empty rather than merely batch-aligned.
export async function drainExpired(pool: pg.Pool, batch: number): Promise<ReapResult> {
  if (batch < 1) throw new Error(`batch must be >= 1, got ${batch}: a LIMIT 0 pass returns no rows, so the short-batch termination never fires`);
  const total: ReapResult = { requeued: 0, deadLettered: 0, dedupeReleased: 0 };
  for (;;) {
    const pass = await reapExpired(pool, batch);
    total.requeued += pass.requeued;
    total.deadLettered += pass.deadLettered;
    total.dedupeReleased += pass.dedupeReleased;
    if (pass.requeued < batch && pass.deadLettered < batch && pass.dedupeReleased < batch) return total;
  }
}
