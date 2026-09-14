import pg from 'pg';

export default async function dropStaleTemplate(): Promise<void> {
  const url = (process.env.DATABASE_URL ?? 'postgres://queue:queue@localhost:5432/queue').replace(/\/[^/]*$/, '/postgres');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS queue_template WITH (FORCE)').catch(() => undefined);
  await admin.end();
}
