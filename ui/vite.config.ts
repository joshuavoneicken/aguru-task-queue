import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/queues': 'http://localhost:3000',
      '/tasks': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/vitest.setup.ts'] },
});
