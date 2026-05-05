/**
 * Single source of truth for the public stats API's cache slot keys. Routes
 * read from these slots; producers (poller / indexer / sampler) invalidate
 * them via `cache.invalidate(...)` in the bootstrap layer. Keeping the
 * strings here — instead of scattered across route modules — makes the
 * producer→slot mapping grep-able and lets the bootstrap stop reaching
 * across route internals.
 */

import type { HistoryRange } from '../store.js';

export const STATS_NETWORK_CACHE_KEY = 'stats:network';
export const STATS_PEERS_CACHE_KEY = 'stats:peers';
export const INSIGHTS_CACHE_KEY = 'insights';

export function historyCacheKey(range: HistoryRange): string {
  return `history:${range}`;
}
