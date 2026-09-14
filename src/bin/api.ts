import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../api/server.js';
import { loadApiConfig } from '../config.js';
import { createPool } from '../store/pool.js';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadApiConfig();
const pool = createPool(config.databaseUrl);
const app = await buildServer(pool, config);
await app.listen({ port: config.port });
console.log(`api listening on port ${config.port}`);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void app
    .close()
    .then(() => pool.end())
    .then(
      () => process.exit(0),
      (thrown) => {
        console.error('shutdown failed', thrown);
        process.exit(1);
      },
    );
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
