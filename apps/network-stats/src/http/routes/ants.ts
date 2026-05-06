/**
 * ANTS token routes — supply, top holders, recent transfers, supply chart.
 *
 *   GET /ants/supply           → { totalSupply, holderCount, lastUpdatedBlock }
 *   GET /ants/holders          → top N by balance
 *   GET /ants/transfers        → recent Transfer chain_events (proxies /events with event=Transfer + contract filter)
 *   GET /ants/supply/history?range=1d|7d|30d  → bucketed snapshot timeline
 *
 * All bigint columns are stringified at this boundary so the client never
 * sees a JSON value past Number.MAX_SAFE_INTEGER.
 */

import type { Express } from 'express';

import type { HistoryRange, SqliteStore } from '../../store.js';
import { ANTS_HOLDERS_CACHE_KEY, ANTS_SUPPLY_CACHE_KEY, antsSupplyHistoryCacheKey } from '../cache-keys.js';
import { asyncHandler } from '../middleware.js';
import { sendCachedJson, type ResponseCache } from '../response-cache.js';
import { bucketSecondsForRange, parseHistoryRange } from '../validators.js';

// Supply moves only on mints/burns — most ticks won't touch it. A short fresh
// window is fine; the slot is invalidated by the indexer's onSupplySampleComplete
// which runs only on actual changes.
const SUPPLY_FRESH_MS = 30_000;
const SUPPLY_STALE_MS = 5 * 60_000;
const HOLDERS_FRESH_MS = 60_000;
const HOLDERS_STALE_MS = 5 * 60_000;
const SUPPLY_HISTORY_FRESH_MS = 60_000;
const SUPPLY_HISTORY_STALE_MS = 6 * 3600_000;

const TOP_HOLDERS_DEFAULT = 25;
const TOP_HOLDERS_MAX = 100;

export interface AntsRouteDeps {
  store?: SqliteStore;
  cache: ResponseCache;
  /** Lowercased ANTS token address — used to scope /ants/transfers by contract. */
  antsContractAddress?: string;
}

interface SupplyPayload {
  totalSupply: string;
  holderCount: number;
  lastUpdatedBlock: number | null;
}

interface HoldersPayload {
  holders: Array<{
    address: string;
    balance: string;
    sharePct: number;
    firstSeenBlock: number;
    lastTxBlock: number;
  }>;
}

interface SupplyHistoryPayload {
  range: HistoryRange;
  bucketSeconds: number;
  points: Array<{ ts: number; totalSupply: string; holderCount: number }>;
}

function emptySupply(): SupplyPayload {
  return { totalSupply: '0', holderCount: 0, lastUpdatedBlock: null };
}

function emptyHolders(): HoldersPayload {
  return { holders: [] };
}

function emptySupplyHistory(range: HistoryRange): SupplyHistoryPayload {
  return { range, bucketSeconds: bucketSecondsForRange(range), points: [] };
}

/**
 * Reduce a stream of supply samples to one row per bucket — last-write-wins
 * within a bucket, which matches the gauge semantics (we want "supply at end
 * of bucket", not the average). Mirrors the bucketing in network_history but
 * trimmed to two fields.
 */
function bucketSupplyHistory(
  rows: readonly { ts: number; totalSupply: bigint; holderCount: number }[],
  bucketSeconds: number,
): SupplyHistoryPayload['points'] {
  const buckets = new Map<number, { totalSupply: bigint; holderCount: number }>();
  for (const row of rows) {
    const bucketTs = Math.floor(row.ts / bucketSeconds) * bucketSeconds;
    buckets.set(bucketTs, { totalSupply: row.totalSupply, holderCount: row.holderCount });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, v]) => ({ ts, totalSupply: v.totalSupply.toString(), holderCount: v.holderCount }));
}

function rangeSeconds(range: HistoryRange): number {
  return range === '1d' ? 86400 : range === '7d' ? 86400 * 7 : 86400 * 30;
}

export function registerAntsRoutes(app: Express, deps: AntsRouteDeps): void {
  const { store, cache, antsContractAddress } = deps;

  app.get('/ants/supply', asyncHandler(async (req, res) => {
    if (!store) {
      res.json(emptySupply());
      return;
    }
    const env = await cache.read<SupplyPayload>(ANTS_SUPPLY_CACHE_KEY, {
      compute: async () => {
        const snapshot = store.getAntsSupply();
        return {
          payload: {
            totalSupply: snapshot.totalSupply.toString(),
            holderCount: snapshot.holderCount,
            lastUpdatedBlock: snapshot.lastUpdatedBlock,
          },
          sourceUpdatedAt: null,
        };
      },
      freshMs: SUPPLY_FRESH_MS,
      staleMs: SUPPLY_STALE_MS,
    });
    sendCachedJson(req, res, env);
  }));

  app.get('/ants/holders', asyncHandler(async (req, res) => {
    if (!store) {
      res.json(emptyHolders());
      return;
    }
    const limitRaw = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : TOP_HOLDERS_DEFAULT;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, TOP_HOLDERS_MAX)
      : TOP_HOLDERS_DEFAULT;

    // Skip caching when a custom limit is supplied — slot-per-limit would be
    // wasteful for the long tail. The default-limit case (the homepage one)
    // hits the cache.
    if (limit === TOP_HOLDERS_DEFAULT) {
      const env = await cache.read<HoldersPayload>(ANTS_HOLDERS_CACHE_KEY, {
        compute: async () => ({
          payload: buildHoldersPayload(store, limit),
          sourceUpdatedAt: null,
        }),
        freshMs: HOLDERS_FRESH_MS,
        staleMs: HOLDERS_STALE_MS,
      });
      sendCachedJson(req, res, env);
      return;
    }
    res.json(buildHoldersPayload(store, limit));
  }));

  app.get('/ants/transfers', asyncHandler(async (req, res) => {
    if (!store) {
      res.json({ events: [], nextCursor: null });
      return;
    }
    const limitRaw = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : 25;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 25;
    // Pull one extra so the route can mint a keyset cursor without re-querying.
    const rows = store.getChainEvents({
      eventName: 'Transfer',
      ...(antsContractAddress ? { contractAddress: antsContractAddress } : {}),
      limit: limit + 1,
    });
    const head = rows.slice(0, limit);
    const next = rows.length > limit ? head[head.length - 1] : undefined;
    res.json({
      events: head,
      nextCursor: next ? { blockNumber: next.blockNumber, logIndex: next.logIndex } : null,
    });
  }));

  app.get('/ants/supply/history', asyncHandler(async (req, res) => {
    const range = parseHistoryRange(req);
    if (!store) {
      res.json(emptySupplyHistory(range));
      return;
    }
    const env = await cache.read<SupplyHistoryPayload>(antsSupplyHistoryCacheKey(range), {
      compute: async () => {
        const bucketSeconds = bucketSecondsForRange(range);
        const rows = store.getAntsSupplyHistory(rangeSeconds(range));
        const points = bucketSupplyHistory(rows, bucketSeconds);
        return {
          payload: { range, bucketSeconds, points },
          sourceUpdatedAt: points.length > 0 ? points[points.length - 1]!.ts * 1000 : null,
        };
      },
      freshMs: SUPPLY_HISTORY_FRESH_MS,
      staleMs: SUPPLY_HISTORY_STALE_MS,
    });
    sendCachedJson(req, res, env);
  }));
}

function buildHoldersPayload(store: SqliteStore, limit: number): HoldersPayload {
  const supply = store.getAntsSupply();
  const holders = store.getTopAntsHolders(limit);
  const totalSupply = supply.totalSupply;
  return {
    holders: holders.map((h) => ({
      address: h.address,
      balance: h.balance.toString(),
      // sharePct is bounded by total supply — when supply is zero (cold
      // start, no transfers indexed yet) we report 0 rather than NaN.
      sharePct:
        totalSupply > 0n
          // Convert via Number division — loses precision past 2^53, fine for a
          // percentage we render to two decimals on the UI.
          ? Number((h.balance * 10_000n) / totalSupply) / 100
          : 0,
      firstSeenBlock: h.firstSeenBlock,
      lastTxBlock: h.lastTxBlock,
    })),
  };
}
