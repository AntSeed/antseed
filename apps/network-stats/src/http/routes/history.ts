import type { Express } from 'express';

import type { HistoryRange, HistoryResponse, SqliteStore } from '../../store.js';
import { bucketSecondsForRange, parseHistoryRange } from '../validators.js';

export interface HistoryRouteDeps {
  store?: SqliteStore;
}

function emptyHistory(range: HistoryRange): HistoryResponse {
  return { range, bucketSeconds: bucketSecondsForRange(range), points: [] };
}

/**
 * Three history routes share range parsing + store lookup. They differ only
 * in which fields they project from each point. When the indexer is disabled
 * (no store), an empty payload is returned for the requested range so the
 * client can render a zero-state without distinguishing 404 from 200.
 */
export function registerHistoryRoutes(app: Express, deps: HistoryRouteDeps): void {
  const load = (range: HistoryRange): HistoryResponse =>
    deps.store ? deps.store.getHistory(range) : emptyHistory(range);

  app.get('/history', (req, res) => {
    res.json(load(parseHistoryRange(req)));
  });

  app.get('/history/peers', (req, res) => {
    const { range, bucketSeconds, points } = load(parseHistoryRange(req));
    res.json({
      range,
      bucketSeconds,
      points: points.map((p) => ({
        ts: p.ts,
        activePeers: p.activePeers,
        requests: p.requests,
        settlements: p.settlements,
      })),
    });
  });

  app.get('/history/tokens', (req, res) => {
    const { range, bucketSeconds, points } = load(parseHistoryRange(req));
    res.json({
      range,
      bucketSeconds,
      points: points.map((p) => ({ ts: p.ts, tokens: p.tokens })),
    });
  });
}
