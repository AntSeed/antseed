/**
 * Express HTTP server — exposes network stats for XHR consumption.
 *
 * GET /stats  →  { peers: PeerMetadata[], updatedAt }
 * GET /health →  { ok: true }
 */

import express from 'express';
import type { NetworkPoller } from './poller.js';
import type { StakingClient } from '@antseed/node';
import type { SqliteStore, TimeframeTotals } from './store.js';
import type { MetadataIndexer } from './indexer.js';

const SECONDS_PER_DAY = 86_400;

// Sellers below this lifetime-request floor are excluded from `risingStars`.
// One-shot or never-settled agents would otherwise dominate the list with
// noisy ratios (e.g. 1 request in 7d / lifetime rate of 1/day = score 7).
const RISING_STARS_MIN_LIFETIME_REQUESTS = 5n;

type RankingMetric = { agentId: number; requests: string; inputTokens: string; outputTokens: string; volume: string; users: number; settlements: number };
type ReachEntry = { agentId: number; uniqueBuyers: number; totalRequests: string };
type RisingStarEntry = { agentId: number; score: number; requests7d: string; lifetimeRequests: string; daysActive: number };
type WindowMetric = { requests: string; inputTokens: string; outputTokens: string; volume: string; users: number; settlements: number };

// Accepts either a TimeframeTotals (windowed) or a SellerTotals-like all-time
// shape — both expose totalRequests/Input/Output, settlementCount, uniqueBuyers.
type MetricSource = {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  uniqueBuyers: number;
};

function makeRankingMetric(agentId: number, t: MetricSource): RankingMetric {
  return {
    agentId,
    requests: t.totalRequests.toString(),
    inputTokens: t.totalInputTokens.toString(),
    outputTokens: t.totalOutputTokens.toString(),
    volume: (t.totalInputTokens + t.totalOutputTokens).toString(),
    users: t.uniqueBuyers,
    settlements: t.settlementCount,
  };
}

// Per-peer windowed totals — same shape as RankingMetric minus the agentId,
// since the agentId is already on the parent onChainStats object.
function toWindowMetric(t: MetricSource | undefined): WindowMetric | null {
  if (!t) return null;
  return {
    requests: t.totalRequests.toString(),
    inputTokens: t.totalInputTokens.toString(),
    outputTokens: t.totalOutputTokens.toString(),
    volume: (t.totalInputTokens + t.totalOutputTokens).toString(),
    users: t.uniqueBuyers,
    settlements: t.settlementCount,
  };
}

function compareBigDesc(a: bigint, b: bigint): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export interface CreateServerDeps {
  poller: NetworkPoller;
  store?: SqliteStore;            // undefined when indexer disabled for this chain
  stakingClient?: StakingClient;  // undefined when indexer disabled
  indexer?: MetadataIndexer;      // source of chain head + reorg buffer for sync status
  chainId?: string;               // used to look up the indexer checkpoint
  contractAddress?: string;       // contract whose checkpoint to expose
  port?: number;
}

// module-scoped cache, key: lowercased address. Staked peers are cached
// indefinitely (agentId assignments don't change). Unstaked peers (agentId=0)
// are cached with a short TTL so a peer that stakes shortly after being
// observed picks up its real agentId on the next request instead of being
// permanently pinned to `onChainStats: null`.
const UNSTAKED_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  agentId: number;
  expiresAt: number; // Infinity for staked (never expires)
}
const agentIdCache = new Map<string, CacheEntry>();

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

async function resolveAgentId(
  client: StakingClient,
  address: string | null | undefined,
): Promise<number | null> {
  const key = normalizeAddress(address);
  if (!key) return null;
  const cached = agentIdCache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.agentId;
  }
  try {
    const agentId = await client.getAgentId(key);
    agentIdCache.set(key, {
      agentId,
      expiresAt: agentId === 0 ? Date.now() + UNSTAKED_TTL_MS : Infinity,
    });
    return agentId;
  } catch (err) {
    console.warn(`[network-stats] getAgentId failed for ${key}:`, err);
    return null;
  }
}

export function __resetAgentIdCacheForTests(): void {
  agentIdCache.clear();
}

export function createServer(deps: CreateServerDeps): { start(): Promise<void>; stop(): void } {
  const { poller, store, stakingClient, indexer, chainId, contractAddress, port = 4000 } = deps;
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    next();
  });

  app.get('/stats', async (_req, res) => {
    const snapshot = poller.getSnapshot();

    // Fast path: no indexer configured. Return snapshot byte-compatibly with the old shape.
    if (!store || !stakingClient) {
      res.json(snapshot);
      return;
    }

    // Pre-compute per-seller windowed totals once per request — three SQL
    // queries total, regardless of peer count. The frontend uses these to
    // sort the discovery list by recent activity (24h / 7d / 30d). All-time
    // is already exposed via the existing onChainStats.totalRequests etc.
    const nowSec = Math.floor(Date.now() / 1000);
    const windowMaps: Record<'last24h' | 'last7d' | 'last30d', Map<number, TimeframeTotals>> = {
      last24h: store.getSellerTotalsSince(nowSec - 1 * SECONDS_PER_DAY),
      last7d: store.getSellerTotalsSince(nowSec - 7 * SECONDS_PER_DAY),
      last30d: store.getSellerTotalsSince(nowSec - 30 * SECONDS_PER_DAY),
    };

    const enrichedPeers = await Promise.all(
      snapshot.peers.map(async (peer) => {
        // peerId is the lowercased seller/operator EVM address without the 0x prefix.
        // Contract-backed sellers (for example Venice's proxy) announce the
        // settlement address separately; use that for on-chain volume lookup.
        const { peerId, sellerContract } = peer as { peerId?: string; sellerContract?: string };
        const address = normalizeAddress(sellerContract) ?? normalizeAddress(peerId);
        const agentId = await resolveAgentId(stakingClient, address);
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
            last24h: toWindowMetric(windowMaps.last24h.get(agentId)),
            last7d: toWindowMetric(windowMaps.last7d.get(agentId)),
            last30d: toWindowMetric(windowMaps.last30d.get(agentId)),
            // Same shape as the windowed metrics so clients can iterate
            // ['last24h', 'last7d', 'last30d', 'allTime'] uniformly. The flat
            // totalRequests/totalInputTokens/etc. fields above are kept for
            // backward compatibility.
            allTime: toWindowMetric(totals),
          },
        };
      }),
    );

    const indexerInfo =
      chainId && contractAddress
        ? store.getCheckpointInfo(chainId, contractAddress.toLowerCase())
        : null;

    // Chain head comes from the indexer's in-memory cache, refreshed on every
    // tick. `synced` is true when the checkpoint has caught up to (latest − reorg
    // buffer), i.e. there's nothing else the indexer could have processed.
    const chainHead = indexer?.getChainHead();
    const indexerPayload = indexerInfo
      ? {
          ...indexerInfo,
          ...(chainHead?.latestBlock != null
            ? {
                latestBlock: chainHead.latestBlock,
                synced: indexerInfo.lastBlock >= chainHead.latestBlock - chainHead.reorgSafetyBlocks,
              }
            : {}),
        }
      : null;

    const networkTotals = store.getNetworkTotals();

    // ── Rankings ─────────────────────────────────────────────────────
    // Global leaderboards across every indexed seller (not just snapshot peers).
    // Frontends join by agentId against the live peer list to resolve display
    // metadata. Lists are returned fully sorted; pagination will be added later.
    const allTimeStats = store.getAllSellerStats();

    // mostUsed/topVolume share the same entry shape and source data — just
    // different sort keys. Build per-window arrays from the windowed maps and
    // an all-time array from allTimeStats.
    const buildWindowEntries = (m: Map<number, TimeframeTotals>): RankingMetric[] =>
      Array.from(m, ([agentId, t]) => makeRankingMetric(agentId, t));

    const allTimeEntries: RankingMetric[] = Array.from(allTimeStats.values()).map((s) =>
      makeRankingMetric(s.agentId, {
        totalRequests: s.totalRequests,
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
        settlementCount: s.settlementCount,
        uniqueBuyers: s.uniqueBuyers,
      }),
    );

    const sortByRequests = (xs: RankingMetric[]) =>
      [...xs].sort((a, b) => compareBigDesc(BigInt(a.requests), BigInt(b.requests)));
    const sortByTokens = (xs: RankingMetric[]) =>
      [...xs].sort((a, b) =>
        compareBigDesc(
          BigInt(a.inputTokens) + BigInt(a.outputTokens),
          BigInt(b.inputTokens) + BigInt(b.outputTokens),
        ),
      );

    const window24h = buildWindowEntries(windowMaps.last24h);
    const window7d = buildWindowEntries(windowMaps.last7d);
    const window30d = buildWindowEntries(windowMaps.last30d);

    // mostReach: rank by uniqueBuyers (all-time) — already counted by store.
    const mostReach: ReachEntry[] = Array.from(allTimeStats.values())
      .filter((s) => s.uniqueBuyers > 0)
      .map((s) => ({
        agentId: s.agentId,
        uniqueBuyers: s.uniqueBuyers,
        totalRequests: s.totalRequests.toString(),
      }))
      .sort((a, b) => b.uniqueBuyers - a.uniqueBuyers);

    // risingStars: ratio of recent-rate (7d) to lifetime-rate, both in
    // requests/day. Score = 1 means the agent is keeping pace with its
    // lifetime average; > 1 = above average, < 1 = slowing down.
    // Skips agents with too little history to be meaningful (lifetime < 5
    // requests, no firstSeenAt timestamp, or zero recent activity).
    const risingStars: RisingStarEntry[] = [];
    for (const stat of allTimeStats.values()) {
      if (stat.totalRequests < RISING_STARS_MIN_LIFETIME_REQUESTS) continue;
      if (stat.firstSeenAt === null) continue;
      const requests7dBig = windowMaps.last7d.get(stat.agentId)?.totalRequests ?? 0n;
      if (requests7dBig === 0n) continue;
      const daysActive = Math.max(1, (nowSec - stat.firstSeenAt) / SECONDS_PER_DAY);
      // Number() coercion is safe — request counts fit comfortably in 2^53.
      const lifetimeRate = Number(stat.totalRequests) / daysActive;
      if (lifetimeRate <= 0) continue;
      const recentRate = Number(requests7dBig) / 7;
      const score = recentRate / lifetimeRate;
      risingStars.push({
        agentId: stat.agentId,
        score,
        requests7d: requests7dBig.toString(),
        lifetimeRequests: stat.totalRequests.toString(),
        daysActive: Math.round(daysActive * 100) / 100,
      });
    }
    risingStars.sort((a, b) => b.score - a.score);

    res.json({
      ...snapshot,
      peers: enrichedPeers,
      totals: {
        totalRequests: networkTotals.totalRequests.toString(),
        totalInputTokens: networkTotals.totalInputTokens.toString(),
        totalOutputTokens: networkTotals.totalOutputTokens.toString(),
        settlementCount: networkTotals.settlementCount,
        sellerCount: networkTotals.sellerCount,
        lastUpdatedAt: networkTotals.lastUpdatedAt,
      },
      rankings: {
        mostUsed: {
          last24h: sortByRequests(window24h),
          last7d: sortByRequests(window7d),
          last30d: sortByRequests(window30d),
          allTime: sortByRequests(allTimeEntries),
        },
        topVolume: {
          last24h: sortByTokens(window24h),
          last7d: sortByTokens(window7d),
          last30d: sortByTokens(window30d),
          allTime: sortByTokens(allTimeEntries),
        },
        mostReach,
        risingStars,
      },
      ...(indexerPayload ? { indexer: indexerPayload } : {}),
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  let server: ReturnType<typeof app.listen> | null = null;

  return {
    start: () =>
      new Promise((resolve) => {
        server = app.listen(port, '0.0.0.0', () => {
          console.log(`[network-stats] HTTP server listening on port localhost:${port}`);
          resolve();
        });
      }),
    stop: () => {
      server?.close();
    },
  };
}
