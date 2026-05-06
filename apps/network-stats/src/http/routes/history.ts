import type { Express } from 'express';

import type { HistoryRange, HistoryResponse, SqliteStore } from '../../store.js';
import { historyCacheKey } from '../cache-keys.js';
import { asyncHandler } from '../middleware.js';
import {
  sendCachedJson,
  sendProjectedJson,
  type CachedEnvelope,
  type ResponseCache,
} from '../response-cache.js';
import { bucketSecondsForRange, parseHistoryRange } from '../validators.js';

// History data updates only when the sampler writes a new bucket (default 60s)
// — wider freshness budget than /stats. Long stale window: old history rows
// don't go bad, they just lag the latest bucket by minutes; SWR is safe.
const HISTORY_FRESH_MS = 60_000;
const HISTORY_STALE_MS = 6 * 3600_000;

export interface HistoryRouteDeps {
  store?: SqliteStore;
  cache: ResponseCache;
}

function emptyHistory(range: HistoryRange): HistoryResponse {
  return { range, bucketSeconds: bucketSecondsForRange(range), points: [] };
}

/**
 * Three history routes share range parsing + store lookup. They differ only
 * in which fields they project from each point. When the indexer is disabled
 * (no store), an empty payload is returned for the requested range so the
 * client can render a zero-state without distinguishing 404 from 200.
 *
 * Caching strategy: one slot per range (3 ranges × 1 base payload = 3 slots).
 * Sub-routes project peers/tokens at request time and rehash the ETag — the
 * underlying SQL fan-out is paid once per range per sampler tick.
 */
export function registerHistoryRoutes(app: Express, deps: HistoryRouteDeps): void {
  const { store, cache } = deps;

  function loadHistoryEnvelope(range: HistoryRange): Promise<CachedEnvelope<HistoryResponse>> {
    return cache.read<HistoryResponse>(historyCacheKey(range), {
      compute: async () => {
        const payload = store ? store.getHistory(range) : emptyHistory(range);
        // Latest bucket's ts marks when the underlying data last advanced.
        // Null when the payload is empty so X-Data-Updated-At is omitted
        // rather than misreporting "epoch".
        const last = payload.points[payload.points.length - 1];
        return { payload, sourceUpdatedAt: last ? last.ts * 1000 : null };
      },
      freshMs: HISTORY_FRESH_MS,
      staleMs: HISTORY_STALE_MS,
    });
  }

  app.get('/history', asyncHandler(async (req, res) => {
    sendCachedJson(req, res, await loadHistoryEnvelope(parseHistoryRange(req)));
  }));

  app.get('/history/peers', asyncHandler(async (req, res) => {
    const env = await loadHistoryEnvelope(parseHistoryRange(req));
    sendProjectedJson(req, res, env, ({ range, bucketSeconds, points }) => ({
      range,
      bucketSeconds,
      points: points.map((p) => ({
        ts: p.ts,
        activePeers: p.activePeers,
        requests: p.requests,
        settlements: p.settlements,
      })),
    }));
  }));

  app.get('/history/tokens', asyncHandler(async (req, res) => {
    const env = await loadHistoryEnvelope(parseHistoryRange(req));
    sendProjectedJson(req, res, env, ({ range, bucketSeconds, points }) => ({
      range,
      bucketSeconds,
      points: points.map((p) => ({ ts: p.ts, tokens: p.tokens })),
    }));
  }));
}
