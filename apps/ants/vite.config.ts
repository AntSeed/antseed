import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendPort = Number(process.env['ANTSEED_ANTS_PORT']) || 3119;

// The dashboard is served by the Fastify server in src/server.ts from
// dist/ants-web; in dev the Vite server proxies /api to a running backend.
export default defineConfig(({ mode }) => {
  const hosted = mode === 'hosted' || mode === 'hosted-test';
  return {
    plugins: [react(), ...(hosted ? [{
      name: 'hosted-entry',
      transformIndexHtml: { order: 'pre' as const, handler(html: string) { return html.replace('/src/main.tsx', '/src/hosted/main.tsx'); } },
      generateBundle(_options: unknown, bundle: Record<string, { type: string; modules?: Record<string, unknown> }>) {
        for (const chunk of Object.values(bundle)) for (const moduleId of Object.keys(chunk.modules ?? {})) {
          if (/node:|better-sqlite3|node-datachannel|\/ants\/src\/(server|jobs)\./.test(moduleId)) throw new Error(`Node-only dependency in hosted bundle: ${moduleId}`);
        }
      },
    }] : [])],
    root: 'web',
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      outDir: path.resolve(__dirname, hosted ? 'dist/ants-hosted' : 'dist/ants-web'),
      emptyOutDir: true,
    },
    server: {
      port: 5181,
      proxy: hosted ? undefined : {
        '/api': { target: process.env['ANTSEED_ANTS_PROXY_TARGET'] || `http://127.0.0.1:${backendPort}`, changeOrigin: true },
      },
    },
  };
});
