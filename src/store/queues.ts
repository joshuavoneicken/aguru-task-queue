import type pg from 'pg';
import type { QueuePolicy, QueuePolicyValues } from '../config.js';

export async function seedQueues(pool: pg.Pool, queues: QueuePolicy[]): Promise<void> {
  for (const q of queues) {
    await pool.query(
      `INSERT INTO queues (name, max_attempts, backoff_base_ms, backoff_cap_ms, dedupe_window_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         max_attempts = EXCLUDED.max_attempts, backoff_base_ms = EXCLUDED.backoff_base_ms,
         backoff_cap_ms = EXCLUDED.backoff_cap_ms, dedupe_window_ms = EXCLUDED.dedupe_window_ms`,
      [q.name, q.maxAttempts, q.backoffBaseMs, q.backoffCapMs, q.dedupeWindowMs],
    );
  }
}

/** Creates the queue with `policy` if it does not exist; an existing queue keeps its own. */
export async function ensureQueue(pool: pg.Pool, name: string, policy: QueuePolicyValues): Promise<void> {
  await pool.query(
    `INSERT INTO queues (name, max_attempts, backoff_base_ms, backoff_cap_ms, dedupe_window_ms)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO NOTHING`,
    [name, policy.maxAttempts, policy.backoffBaseMs, policy.backoffCapMs, policy.dedupeWindowMs],
  );
}

export async function queueExists(pool: pg.Pool, name: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM queues WHERE name = $1', [name]);
  return rowCount === 1;
}

export async function listQueues(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM queues ORDER BY name');
  return rows.map((r) => r.name);
}
