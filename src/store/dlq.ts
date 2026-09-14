import type pg from 'pg';
import type { Cursor } from '../domain/cursor.js';
import { encodeCursor } from '../domain/cursor.js';
import type { TaskRecord } from './tasks.js';
import { queueExists } from './queues.js';

// The listing is a triage surface shipped to every UI viewer, so `payload` and `result` stay
// out of the projection deliberately — payloads carry code, prompts and credentials (SPEC §9).
// Drill-in on a single task goes through GET /tasks/:id, which does return both.
export type DlqRecord = Omit<TaskRecord, 'payload' | 'result'>;

export interface DlqPage { tasks: DlqRecord[]; nextCursor: string | null }

type DlqRow = DlqRecord & { failedAtCursor: string };

// Queries tasks directly rather than the task_state view: with failed_at IS NOT NULL, view-state
// 'dlq' <=> status 'dlq' in both directions — dlq_has_failed_at guarantees no dlq row is excluded,
// and the only other view-dlq shape (expired-exhausted in_flight) always has failed_at IS NULL.
// The view's CASE would defeat the tasks_dlq_idx partial-index match; the direct predicate is
// served by it. The excluded unreaped row is deliberately absent: keyset pagination needs
// failed_at, and the reaper lands within a tick.
//
// failedAtCursor carries failed_at at full microsecond precision; a JS Date floors to
// milliseconds, and the reaper stamps a whole dead-lettered batch with one now(), so a truncated
// cursor would skip same-millisecond rows at every page boundary.
const LIST_DLQ = `
  SELECT id, queue_name AS queue, type, 'dlq'::task_status AS state, attempts,
         max_attempts AS "maxAttempts", failure_kind AS "failureKind",
         last_error AS "lastError", created_at AS "createdAt",
         succeeded_at AS "succeededAt", failed_at AS "failedAt",
         to_char(failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "failedAtCursor"
    FROM tasks
   WHERE queue_name = $1 AND status = 'dlq' AND failed_at IS NOT NULL
     AND ($2::timestamptz IS NULL OR (failed_at, id) < ($2, $3))
   ORDER BY failed_at DESC, id DESC
   LIMIT $4`;

export async function listDlq(
  pool: pg.Pool, queue: string, limit: number, cursor?: Cursor,
): Promise<DlqPage | null> {
  if (!(await queueExists(pool, queue))) return null;
  const { rows } = await pool.query<DlqRow>(LIST_DLQ,
    [queue, cursor?.failedAt ?? null, cursor?.id ?? null, limit + 1]);
  const overflow = rows.length > limit;
  const page = rows.slice(0, limit);
  const tail = page[page.length - 1];
  return {
    tasks: page.map(({ failedAtCursor, ...task }) => task),
    nextCursor: overflow && tail !== undefined
      ? encodeCursor({ failedAt: tail.failedAtCursor, id: tail.id })
      : null,
  };
}
