import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../dist-web'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3117',
      '/ws': {
        target: 'ws://localhost:3117',
        ws: true,
      },
    },
  },
});
