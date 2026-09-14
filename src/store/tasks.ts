import type pg from 'pg';
import type { FailureKind } from '../domain/failure.js';
import type { ClaimId, TaskId, TaskType } from '../domain/task.js';

export interface EnqueueInput {
  type: TaskType;
  payload: unknown;
  delayMs?: number;
  dedupeKey?: string;
}

// INSERT ... SELECT copies the queue's policy onto the row in the same statement; the FK
// takes only KEY SHARE on the queues row, so concurrent enqueues to one queue never serialise.
// ON CONFLICT DO UPDATE (a self-assign no-op) rather than DO NOTHING: it returns the surviving
// row in one statement, and xmax = 0 distinguishes a fresh insert from a dedupe hit (§7).
const ENQUEUE = `
  INSERT INTO tasks (queue_name, type, payload, run_after, dedupe_key, dedupe_expires_at,
                     max_attempts, backoff_base_ms, backoff_cap_ms)
  SELECT q.name, $2, $3, now() + make_interval(secs => $4::numeric / 1000.0),
         $5, CASE WHEN $5::text IS NULL THEN NULL
                  ELSE now() + make_interval(secs => q.dedupe_window_ms / 1000.0) END,
         q.max_attempts, q.backoff_base_ms, q.backoff_cap_ms
  FROM queues q WHERE q.name = $1
  ON CONFLICT (queue_name, dedupe_key) WHERE dedupe_key IS NOT NULL
  DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
  RETURNING id, (xmax = 0) AS created`;

export async function enqueue(
  pool: pg.Pool, queue: string, input: EnqueueInput,
): Promise<{ id: TaskId; created: boolean }> {
  const { rows } = await pool.query<{ id: TaskId; created: boolean }>(ENQUEUE, [
    queue, input.type, JSON.stringify(input.payload), input.delayMs ?? 0, input.dedupeKey ?? null,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`queue ${queue} does not exist; ensureQueue before enqueue`);
  return row;
}

export interface ClaimedRow {
  id: TaskId;
  type: TaskType;
  payload: unknown;
  attempts: number;
  claimId: ClaimId;
  leaseExpiresAt: Date;
}

// Per SPEC §2: the whole predicate lives inside the locking subquery, so READ COMMITTED's
// post-lock re-check re-tests status, and SKIP LOCKED keeps losers wait-free.
const CLAIM = `
  WITH claimable AS (
    SELECT id FROM tasks
    WHERE queue_name = $1 AND status = 'ready' AND run_after <= now()
    ORDER BY run_after
    FOR UPDATE SKIP LOCKED
    LIMIT $2
  )
  UPDATE tasks t
     SET status = 'in_flight', worker_id = $3, claim_id = gen_random_uuid(),
         claimed_at = now(), lease_expires_at = now() + make_interval(secs => $4::numeric / 1000.0),
         attempts = attempts + 1
    FROM claimable c WHERE t.id = c.id
  RETURNING t.id, t.type, t.payload, t.attempts, t.claim_id AS "claimId",
            t.lease_expires_at AS "leaseExpiresAt"`;

export async function claim(
  pool: pg.Pool, queue: string, workerId: string, max: number, leaseMs: number,
): Promise<ClaimedRow[]> {
  const { rows } = await pool.query<ClaimedRow>(CLAIM, [queue, max, workerId, leaseMs]);
  return rows;
}

// The fence predicate — worker_id = $n AND status = 'in_flight' AND ($m::uuid IS NULL OR
// claim_id = $m) — is written out in each statement rather than composed, so every query is
// greppable and its parameter numbers stay local.
export async function ack(
  pool: pg.Pool, id: TaskId, workerId: string, result: unknown, claimId?: ClaimId,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE tasks
        SET status = 'succeeded', result = $3, succeeded_at = now(),
            worker_id = NULL, claim_id = NULL, lease_expires_at = NULL
      WHERE id = $1 AND worker_id = $2 AND status = 'in_flight'
        AND ($4::uuid IS NULL OR claim_id = $4)`,
    [id, workerId, JSON.stringify(result ?? null), claimId ?? null],
  );
  return rowCount === 1;
}

export interface NackInput {
  reason: string;
  retryable: boolean;
  kind: FailureKind;
  forgiveAttempt?: boolean;
  claimId?: ClaimId;
}

// Forgiveness applies only under the cap; at the cap the nack degrades to a counted one (§4).
// Terminal or exhausted goes to the DLQ; retryable re-readies with backoff, forgiven re-readies
// immediately (nothing failed). The forgiveness predicate and the post-nack attempt count are
// computed once in the CTE and referenced by every SET clause, so there is one copy to read.
// `backoff_run_after(t.attempts, ...)` keeps the pre-nack count: in the non-forgiving retryable
// branch next_attempts equals attempts, so the ladder is unchanged.
export async function nack(
  pool: pg.Pool, id: TaskId, workerId: string, input: NackInput,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `WITH target AS (
       SELECT id, ($5 AND attempts_forgiven < max_attempts) AS forgiving
         FROM tasks
        WHERE id = $1 AND worker_id = $2 AND status = 'in_flight'
          AND ($7::uuid IS NULL OR claim_id = $7)
        FOR UPDATE
     ), verdict AS (
       SELECT t.id, g.forgiving,
              t.attempts - CASE WHEN g.forgiving THEN 1 ELSE 0 END AS next_attempts
         FROM tasks t JOIN target g ON g.id = t.id
     )
     UPDATE tasks t
        SET attempts          = v.next_attempts,
            attempts_forgiven = t.attempts_forgiven + CASE WHEN v.forgiving THEN 1 ELSE 0 END,
            failure_kind = $4, last_error = $3,
            worker_id = NULL, claim_id = NULL, lease_expires_at = NULL,
            status    = CASE WHEN NOT $6 OR v.next_attempts >= t.max_attempts THEN 'dlq'::task_status ELSE 'ready'::task_status END,
            failed_at = CASE WHEN NOT $6 OR v.next_attempts >= t.max_attempts THEN now() ELSE NULL END,
            run_after = CASE
              WHEN $6 AND v.forgiving THEN now()
              WHEN $6 AND v.next_attempts < t.max_attempts THEN backoff_run_after(t.attempts, t.backoff_base_ms, t.backoff_cap_ms)
              ELSE t.run_after END
       FROM verdict v WHERE t.id = v.id`,
    [id, workerId, input.reason, input.kind, input.forgiveAttempt ?? false, input.retryable, input.claimId ?? null],
  );
  return rowCount === 1;
}

export async function extend(
  pool: pg.Pool, id: TaskId, workerId: string, leaseMs: number,
  maxTaskExecutionMs: number, claimId?: ClaimId,
): Promise<Date | null> {
  const { rows } = await pool.query<{ lease_expires_at: Date }>(
    `UPDATE tasks SET lease_expires_at = now() + make_interval(secs => $3::numeric / 1000.0)
      WHERE id = $1 AND worker_id = $2 AND status = 'in_flight'
        AND claimed_at > now() - make_interval(secs => $4::numeric / 1000.0)
        AND ($5::uuid IS NULL OR claim_id = $5)
      RETURNING lease_expires_at`,
    [id, workerId, leaseMs, maxTaskExecutionMs, claimId ?? null],
  );
  return rows[0]?.lease_expires_at ?? null;
}

export async function requeue(pool: pg.Pool, id: TaskId): Promise<'ok' | 'not_found' | 'not_in_dlq'> {
  const { rowCount } = await pool.query(
    `UPDATE tasks
        SET status = 'ready', attempts = 0, attempts_forgiven = 0, run_after = now(),
            worker_id = NULL, claim_id = NULL, claimed_at = NULL, lease_expires_at = NULL,
            failed_at = NULL, failure_kind = NULL, last_error = NULL
      WHERE id = $1 AND status = 'dlq'`,
    [id],
  );
  if (rowCount === 1) return 'ok';
  const { rowCount: exists } = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [id]);
  return exists === 1 ? 'not_in_dlq' : 'not_found';
}

export interface TaskRecord {
  id: TaskId;
  queue: string;
  type: TaskType;
  payload: unknown;
  state: 'ready' | 'in_flight' | 'succeeded' | 'dlq';
  attempts: number;
  maxAttempts: number;
  result: unknown;
  failureKind: FailureKind | null;
  lastError: string | null;
  createdAt: Date;
  succeededAt: Date | null;
  failedAt: Date | null;
}

export async function getTask(pool: pg.Pool, id: TaskId): Promise<TaskRecord | null> {
  const { rows } = await pool.query<TaskRecord>(
    `SELECT id, queue_name AS queue, type, payload, state, attempts,
            max_attempts AS "maxAttempts", result, failure_kind AS "failureKind",
            last_error AS "lastError", created_at AS "createdAt",
            succeeded_at AS "succeededAt", failed_at AS "failedAt"
       FROM task_state WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
