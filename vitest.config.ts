import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

if (existsSync(new URL('./.env', import.meta.url))) {
  process.loadEnvFile();
}

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'harness/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'harness/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'harness/**/*.test.ts',
        // The forked child runs in a separate process the v8 provider cannot instrument;
        // it is exercised end-to-end by test/js-handler.test.ts against a real fork.
        'src/handlers/js-child.ts',
        // Entrypoints are wiring, covered by the lifecycle smoke (SPEC §4) not unit tests.
        'src/bin/**',
        // Test double, not shipped code.
        'harness/testing/manual-clock.ts',
      ],
      reporter: ['text-summary', 'text'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
