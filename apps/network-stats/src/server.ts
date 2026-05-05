/**
 * Express HTTP server — exposes network stats for XHR consumption.
 *
 * GET /stats  →  { peers: PeerMetadata[], updatedAt }
 * GET /health →  { ok: true }
 */

import express from 'express';
import type { NetworkPoller } from './poller.js';
import type { StakingClient } from '@antseed/node';
import type { SqliteStore, HistoryRange } from './store.js';
import type { MetadataIndexer } from './indexer.js';
import { computeNetworkMetrics } from './metrics.js';
import { computeInsights, type NetworkInsights } from './insights.js';
import { getPeerLookupAddress, mapWithConcurrency, normalizeAddress } from './utils.js';

// Velocity needs at least 2× the longest window so growth-pct denominators
// have somewhere to land — we expose a 7d window, so request 14d of history.
const INSIGHTS_HISTORY_WINDOW_SECONDS = 14 * 86400;
// Stability/movers compare prices across this window; matches the constant
// in insights.ts (PRICE_STABILITY_WINDOW_SECONDS) so the SQL filter and the
// computed-window-seconds field stay in sync.
const INSIGHTS_PRICE_WINDOW_SECONDS = 30 * 86400;
// Trending compares last 24h vs prior 7d, so we need 8d of seller activity.
const INSIGHTS_ACTIVITY_WINDOW_SECONDS = 8 * 86400;
// /insights re-runs SQL across all sellers + sorts on every hit. The web
// client polls at 30s while on the relevant routes, so a short TTL memo is
// pure win — the freshness budget for these derivations is well above 15s
// (they're driven by the indexer's per-tick state, which advances at minute
// cadence at best).
const INSIGHTS_CACHE_TTL_MS = 15_000;

const HISTORY_RANGES: readonly HistoryRange[] = ['1d', '7d', '30d'] as const;
function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && (HISTORY_RANGES as readonly string[]).includes(value);
}

/**
 * Snapshot of the one-shot chain backfill, polled every /stats request. The
 * shape mirrors apps/network-stats/src/index.ts BackfillStatus 1:1; we keep
 * the type structural here to avoid cross-importing back into index.ts.
 */
export interface BackfillStatusPayload {
  state: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;
  finishedAt: number | null;
  scannedBlocks: number;
  totalBlocks: number;
  events: number;
  rowsWritten: number;
  phase: 'scanning' | 'resolving-timestamps' | 'done' | null;
  errorMessage: string | null;
}

export interface CreateServerDeps {
  poller: NetworkPoller;
  store?: SqliteStore;            // undefined when indexer disabled for this chain
  stakingClient?: StakingClient;  // undefined when indexer disabled
  indexer?: MetadataIndexer;      // source of chain head + reorg buffer for sync status
  chainId?: string;               // used to look up the indexer checkpoint
  contractAddress?: string;       // contract whose checkpoint to expose
  getBackfillStatus?: () => BackfillStatusPayload;
  port?: number;
}

const UNSTAKED_TTL_MS = 5 * 60 * 1000;
const AGENT_ID_LOOKUP_CONCURRENCY = 8;
interface CacheEntry {
  agentId: number;
  expiresAt: number; // Infinity for staked (never expires)
}

async function resolveAgentId(
  client: StakingClient,
  cache: Map<string, CacheEntry>,
  address: string | null | undefined,
): Promise<number | null> {
  const key = normalizeAddress(address);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.agentId;
  }
  try {
    const agentId = await client.getAgentId(key);
    cache.set(key, {
      agentId,
      expiresAt: agentId === 0 ? Date.now() + UNSTAKED_TTL_MS : Infinity,
    });
    return agentId;
  } catch (err) {
    console.warn(`[network-stats] getAgentId failed for ${key}:`, err);
    return null;
  }
}

async function resolveAgentIds(
  client: StakingClient,
  cache: Map<string, CacheEntry>,
  addresses: readonly (string | null)[],
): Promise<Map<string, number | null>> {
  const uniqueAddresses = [...new Set(addresses.filter((a): a is string => a !== null))];
  const entries = await mapWithConcurrency(
    uniqueAddresses,
    AGENT_ID_LOOKUP_CONCURRENCY,
    async (address) => [address, await resolveAgentId(client, cache, address)] as const,
  );
  return new Map(entries);
}

export function createServer(deps: CreateServerDeps): { start(): Promise<void>; stop(): void } {
  const { poller, store, stakingClient, indexer, chainId, contractAddress, getBackfillStatus, port = 4000 } = deps;
  const app = express();
  // Per-server cache, key: lowercased address. Staked peers are cached
  // indefinitely (agentId assignments don't change). Unstaked peers (agentId=0)
  // use a short TTL so a newly-staked peer is picked up soon after. This is
  // intentionally per createServer() call to keep tests and colocated servers
  // isolated; the address universe here is bounded by recently observed peers.
  const agentIdCache = new Map<string, CacheEntry>();

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    next();
  });

  app.get('/stats', async (_req, res) => {
    const snapshot = poller.getSnapshot();
    const network = computeNetworkMetrics(snapshot.peers);

    // Fast path: no indexer configured. Same shape as before, plus the new
    // network metrics block. Adding a new key is backward-compatible —
    // older clients that only read `peers`/`updatedAt` keep working.
    if (!store || !stakingClient) {
      res.json({ ...snapshot, network });
      return;
    }

    const peerLookupAddresses = snapshot.peers.map((peer) =>
      getPeerLookupAddress(peer as { peerId?: string; sellerContract?: string }),
    );
    const agentIdsByAddress = await resolveAgentIds(stakingClient, agentIdCache, peerLookupAddresses);

    const enrichedPeers = snapshot.peers.map((peer, index) => {
      const address = peerLookupAddresses[index] ?? null;
      const agentId = address ? agentIdsByAddress.get(address) ?? null : null;
      if (agentId === null || agentId === 0) {
        return { ...peer, onChainStats: null };
      }
      const totals = store.getSellerTotals(agentId);
      if (!totals) {
        return { ...peer, onChainStats: null };
      }
      return {
        ...peer,
        onChainStats: {
          agentId,
          totalRequests: totals.totalRequests.toString(),
          totalInputTokens: totals.totalInputTokens.toString(),
          totalOutputTokens: totals.totalOutputTokens.toString(),
          settlementCount: totals.settlementCount,
          uniqueBuyers: totals.uniqueBuyers,
          uniqueChannels: totals.uniqueChannels,
          firstSettledBlock: totals.firstSettledBlock,
          lastSettledBlock: totals.lastSettledBlock,
          firstSeenAt: totals.firstSeenAt,
          lastSeenAt: totals.lastSeenAt,
          avgRequestsPerChannel: totals.avgRequestsPerChannel,
          avgRequestsPerBuyer: totals.avgRequestsPerBuyer,
          lastUpdatedAt: totals.lastUpdatedAt,
        },
      };
    });

    const indexerInfo =
      chainId && contractAddress
        ? store.getCheckpointInfo(chainId, contractAddress.toLowerCase())
        : null;

    // Chain head comes from the indexer's in-memory cache, refreshed on every
    // tick. `synced` is true when the checkpoint has caught up to (latest − reorg
    // buffer), i.e. there's nothing else the indexer could have processed.
    const chainHead = indexer?.getChainHead();
    const health = indexer?.getHealth();
    const indexerPayload =
      indexerInfo && chainId && contractAddress
        ? {
            chainId,
            contractAddress,
            ...indexerInfo,
            ...(chainHead?.latestBlock != null
              ? {
                  latestBlock: chainHead.latestBlock,
                  synced: indexerInfo.lastBlock >= chainHead.latestBlock - chainHead.reorgSafetyBlocks,
                }
              : {}),
            ...(health ?? {}),
          }
        : null;

    const networkTotals = store.getNetworkTotals();

    const backfillPayload = getBackfillStatus?.() ?? null;

    res.json({
      ...snapshot,
      peers: enrichedPeers,
      network,
      totals: {
        totalRequests: networkTotals.totalRequests.toString(),
        totalInputTokens: networkTotals.totalInputTokens.toString(),
        totalOutputTokens: networkTotals.totalOutputTokens.toString(),
        settlementCount: networkTotals.settlementCount,
        sellerCount: networkTotals.sellerCount,
        lastUpdatedAt: networkTotals.lastUpdatedAt,
      },
      ...(indexerPayload ? { indexer: indexerPayload } : {}),
      ...(backfillPayload ? { backfill: backfillPayload } : {}),
    });
  });

  // Per-server cache of the latest /insights response. Keyed implicitly by
  // "this server instance" — the payload is fully derivable from store +
  // poller snapshot, both of which are server-instance-scoped.
  let insightsCache: { computedAt: number; payload: NetworkInsights } | null = null;

  app.get('/insights', async (_req, res) => {
    if (insightsCache && Date.now() - insightsCache.computedAt < INSIGHTS_CACHE_TTL_MS) {
      res.json(insightsCache.payload);
      return;
    }
    const snapshot = poller.getSnapshot();

    // Without the indexer + staking client we can still answer the DHT-only
    // sections (pricing, services, regions, mostStaked, mostDiverse). Pass
    // empty arrays / map for everything chain-derived so the same handler
    // works on chains where the indexer is disabled.
    if (!store || !stakingClient) {
      const payload = computeInsights({
        peers: snapshot.peers,
        sellerTotals: [],
        agentIdByPeerAddress: new Map(),
        history: [],
        priceVolatility: [],
        sellerActivity: [],
      });
      insightsCache = { computedAt: Date.now(), payload };
      res.json(payload);
      return;
    }

    const peerLookupAddresses = snapshot.peers.map((peer) =>
      getPeerLookupAddress(peer as { peerId?: string; sellerContract?: string }),
    );
    const agentIdByPeerAddress = await resolveAgentIds(stakingClient, agentIdCache, peerLookupAddresses);

    const sellerTotals = store.getAllSellerTotalsWithIds();
    const history = store.getHistorySince(INSIGHTS_HISTORY_WINDOW_SECONDS);
    const nowSec = Math.floor(Date.now() / 1000);
    const priceVolatility = store.getPriceVolatility(nowSec - INSIGHTS_PRICE_WINDOW_SECONDS);
    const sellerActivity = store.getSellerActivityForTrending(nowSec - INSIGHTS_ACTIVITY_WINDOW_SECONDS);

    const payload = computeInsights({
      peers: snapshot.peers,
      sellerTotals,
      agentIdByPeerAddress,
      history,
      priceVolatility,
      sellerActivity,
    });
    insightsCache = { computedAt: Date.now(), payload };
    res.json(payload);
  });

  app.get('/history', (req, res) => {
    if (!store) {
      // No store means the indexer is disabled — there's no history to serve.
      // Return an empty payload (default range 1d) so the client can render
      // an "empty chart" state without distinguishing 404 from 200.
      res.json({ range: '1d', bucketSeconds: 3600, points: [] });
      return;
    }
    const rangeParam = typeof req.query['range'] === 'string' ? req.query['range'] : '1d';
    if (!isHistoryRange(rangeParam)) {
      res.status(400).json({ error: `invalid range; expected one of ${HISTORY_RANGES.join(',')}` });
      return;
    }
    res.json(store.getHistory(rangeParam));
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  let server: ReturnType<typeof app.listen> | null = null;

  return {
    start: () =>
      new Promise((resolve) => {
        server = app.listen(port, '0.0.0.0', () => {
          console.log(`[network-stats] HTTP server listening at http://localhost:${port}`);
          resolve();
        });
      }),
    stop: () => {
      server?.close();
    },
  };
}
