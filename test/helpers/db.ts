import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../scripts/migrate.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://queue:queue@localhost:5432/queue';
const ADMIN_URL = DATABASE_URL.replace(/\/[^/]*$/, '/postgres');
const TEMPLATE = 'queue_template';
const LOCK_KEY = 7_002_001;

async function withTemplateLock<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      return await fn(admin);
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await admin.end();
  }
}

let templateReady: Promise<void> | undefined;

function buildTemplate(): Promise<void> {
  templateReady ??= withTemplateLock(async (admin) => {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEMPLATE]);
    if (rowCount === 1) return; // another test file already built it this run
    await admin.query(`CREATE DATABASE ${TEMPLATE}`);
    await migrate(DATABASE_URL.replace(/\/[^/]*$/, `/${TEMPLATE}`));
  });
  return templateReady;
}

export async function withDb(fn: (pool: pg.Pool) => Promise<void>): Promise<void> {
  await buildTemplate();
  const name = `queue_test_${randomUUID().replaceAll('-', '')}`;
  await withTemplateLock((admin) => admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`));
  const pool = new pg.Pool({ connectionString: DATABASE_URL.replace(/\/[^/]*$/, `/${name}`), max: 10 });
  // Teardown drops this database WITH (FORCE), which terminates any idle pooled connection; pg
  // reports that on the pool's 'error' event. With no listener it is an uncaught exception that
  // flakes the run (Postgres 57P01), so absorb it — a terminated connection here is expected.
  pool.on('error', () => undefined);
  try {
    await fn(pool);
  } finally {
    // Tolerates a test that already ended the pool itself (to simulate a store failure).
    await pool.end().catch(() => undefined);
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}
