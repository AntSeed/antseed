import type { Express } from 'express';

export function registerHealthRoutes(app: Express): void {
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
}
