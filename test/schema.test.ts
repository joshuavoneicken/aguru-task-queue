import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withDb } from './helpers/db.js';

async function seedQueue(pool: pg.Pool): Promise<void> {
  await pool.query(`INSERT INTO queues (name, max_attempts, backoff_base_ms, backoff_cap_ms, dedupe_window_ms) VALUES ('q', 5, 3000, 300000, 600000)`);
}

const insertTask = `
  INSERT INTO tasks (queue_name, type, payload, status, attempts, max_attempts, backoff_base_ms, backoff_cap_ms,
                     worker_id, claim_id, claimed_at, lease_expires_at, failed_at)
  VALUES ('q', 'js', '{}', $1, $2, 5, 3000, 300000, $3, $4, $5, $6, $7)`;

describe('schema invariants', () => {
  it('refuses a ready task whose attempts are exhausted', async () => {
    await withDb(async (pool) => {
      await seedQueue(pool);
      await expect(pool.query(insertTask, ['ready', 5, null, null, null, null, null]))
        .rejects.toThrow(/ready_has_attempts_left/);
    });
  });

  it('refuses in_flight without lease, worker, claim id and claim time', async () => {
    await withDb(async (pool) => {
      await seedQueue(pool);
      await expect(pool.query(insertTask, ['in_flight', 1, 'w1', null, null, null, null]))
        .rejects.toThrow(/in_flight_has_claim/);
    });
  });

  it('refuses dlq without failed_at', async () => {
    await withDb(async (pool) => {
      await seedQueue(pool);
      await expect(pool.query(insertTask, ['dlq', 5, null, null, null, null, null]))
        .rejects.toThrow(/dlq_has_failed_at/);
    });
  });

  it('caps attempt forgiveness at max_attempts', async () => {
    await withDb(async (pool) => {
      await seedQueue(pool);
      await expect(pool.query(
        `INSERT INTO tasks (queue_name, type, payload, attempts_forgiven, max_attempts, backoff_base_ms, backoff_cap_ms)
         VALUES ('q', 'js', '{}', 6, 5, 3000, 300000)`,
      )).rejects.toThrow(/attempts_sane/);
    });
  });

  it('allows one live dedupe key per queue and frees it when cleared', async () => {
    await withDb(async (pool) => {
      await seedQueue(pool);
      const dupe = `INSERT INTO tasks (queue_name, type, payload, dedupe_key, max_attempts, backoff_base_ms, backoff_cap_ms)
                    VALUES ('q', 'js', '{}', 'k', 5, 3000, 300000)`;
      await pool.query(dupe);
      await expect(pool.query(dupe)).rejects.toThrow(/tasks_dedupe_idx/);
      await pool.query(`UPDATE tasks SET dedupe_key = NULL`);
      await pool.query(dupe);
    });
  });

  it('backoff_run_after draws inside the factor-4 bound and the cap binds at attempt 4', async () => {
    await withDb(async (pool) => {
      for (const [attempts, boundMs] of [[1, 12_000], [2, 48_000], [3, 192_000], [4, 300_000]] as const) {
        const { rows } = await pool.query<{ max_s: number }>(
          `SELECT max(extract(epoch FROM backoff_run_after($1, 3000, 300000) - now()))::float8 AS max_s
             FROM generate_series(1, 200)`, [attempts]);
        const maxS = rows[0]!.max_s;
        expect(maxS).toBeLessThanOrEqual(boundMs / 1000);
        expect(maxS).toBeGreaterThan(boundMs / 1000 * 0.9); // the exponent is real, not flat
      }
    });
  });

  it('task_state reports an expired lease as ready, or dlq when attempts are exhausted', async () => {
    await withDb(async (pool) => {
      await seedQueue(pool);
      const expired = (attempts: number) => pool.query(
        `INSERT INTO tasks (queue_name, type, payload, status, attempts, max_attempts, backoff_base_ms, backoff_cap_ms,
                            worker_id, claim_id, claimed_at, lease_expires_at)
         VALUES ('q', 'js', '{}', 'in_flight', $1, 5, 3000, 300000,
                 'w1', gen_random_uuid(), now(), now() - interval '1 second')
         RETURNING id`, [attempts]);
      const a = await expired(1);
      const b = await expired(5);
      const state = async (id: string) =>
        (await pool.query<{ state: string }>('SELECT state FROM task_state WHERE id = $1', [id])).rows[0]!.state;
      expect(await state(a.rows[0]!.id)).toBe('ready');
      expect(await state(b.rows[0]!.id)).toBe('dlq');
    });
  });

  it('no index covers the heartbeat-hot columns', async () => {
    await withDb(async (pool) => {
      const { rows } = await pool.query(
        `SELECT i.indexrelid::regclass AS index, a.attname
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'tasks'::regclass
            AND a.attname IN ('lease_expires_at', 'worker_id', 'claim_id', 'claimed_at')`);
      expect(rows).toEqual([]);
    });
  });
});
