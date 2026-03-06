import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rendererRoot = path.resolve(__dirname, 'src/renderer');

export default defineConfig({
  plugins: [react()],
  base: './',
  root: rendererRoot,
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly'
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
