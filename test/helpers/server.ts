import type pg from 'pg';
import { loadApiConfig } from '../../src/config.js';
import { buildServer } from '../../src/api/server.js';
import { withDb } from './db.js';

export async function withServer(
  fn: (ctx: { baseUrl: string; pool: pg.Pool }) => Promise<void>,
  env?: Record<string, string>,
): Promise<void> {
  await withDb(async (pool) => {
    // The port in config is irrelevant here: listen() below binds an ephemeral port directly.
    const config = loadApiConfig({ ...process.env, ...env });
    const app = await buildServer(pool, config);
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      await fn({ baseUrl, pool });
    } finally {
      await app.close();
    }
  });
}
