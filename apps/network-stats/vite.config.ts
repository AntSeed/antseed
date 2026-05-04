import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_PORT = process.env['PORT'] ?? '4000';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      '/stats': `http://127.0.0.1:${SERVER_PORT}`,
      '/health': `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
});
