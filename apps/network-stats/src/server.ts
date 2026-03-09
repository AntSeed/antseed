/**
 * Express HTTP server — exposes network stats for XHR consumption.
 *
 * GET /stats  →  { peers, models, updatedAt }
 * GET /health →  { ok: true }
 */

import express from 'express';
import type { NetworkPoller } from './poller.js';

export function createServer(poller: NetworkPoller, port = 4000): { start(): Promise<void>; stop(): void } {
  const app = express();

  // CORS — allow any origin (public read-only endpoint)
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    next();
  });

  app.get('/stats', (_req, res) => {
    res.json(poller.getSnapshot());
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  let server: ReturnType<typeof app.listen> | null = null;

  return {
    start: () =>
      new Promise((resolve) => {
        server = app.listen(port, '0.0.0.0', () => {
          console.log(`[network-stats] HTTP server listening on port ${port}`);
          resolve();
        });
      }),
    stop: () => {
      server?.close();
    },
  };
}
