import { describe, expect, it } from 'vitest';
import { withDb } from './db.js';

describe('withDb', () => {
  it('hands out an isolated database that can create and query a table', async () => {
    await withDb(async (pool) => {
      await pool.query('CREATE TABLE probe (n int)');
      await pool.query('INSERT INTO probe VALUES (1)');
      const { rows } = await pool.query<{ n: number }>('SELECT n FROM probe');
      expect(rows[0]?.n).toBe(1);
    });
  });
});
