import path from 'node:path';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rendererRoot = path.resolve(__dirname, 'src/renderer');
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  base: './',
  root: rendererRoot,
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(rendererRoot, 'index.html'),
        // Detachable always-on-top pill window (see src/main/window.ts).
        float: path.resolve(rendererRoot, 'float.html'),
      },
    },
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly'
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
