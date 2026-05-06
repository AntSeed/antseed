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
/**
 * Single slot for the explorer homepage feed (`/events` with no filters).
 * Filtered queries skip the cache — cardinality is too high to justify a
 * slot per filter combination.
 */
export const EVENTS_RECENT_CACHE_KEY = 'events:recent';
export const ANTS_SUPPLY_CACHE_KEY = 'ants:supply';
export const ANTS_HOLDERS_CACHE_KEY = 'ants:holders';
export const REPUTATION_RECENT_CACHE_KEY = 'reputation:recent';
export const REPUTATION_LEADERBOARD_CACHE_KEY = 'reputation:leaderboard';

export function historyCacheKey(range: HistoryRange): string {
  return `history:${range}`;
}

export function antsSupplyHistoryCacheKey(range: HistoryRange): string {
  return `ants:supply:history:${range}`;
}

export function reputationAgentCacheKey(agentId: number): string {
  return `reputation:agent:${agentId}`;
}
