/**
 * Express HTTP server — exposes network stats for XHR consumption.
 *
 * GET /stats  →  { peers: PeerMetadata[], updatedAt }
 * GET /health →  { ok: true }
 */

import express from 'express';
import type { NetworkPoller } from './poller.js';
import type { StakingClient } from '@antseed/node';
import type { SqliteStore, LeaderboardRole, LeaderboardPeriod } from './store.js';
import type { MetadataIndexer } from './indexer.js';
import type { SettlementIndexer } from './settlement-indexer.js';

export interface CreateServerDeps {
  poller: NetworkPoller;
  store?: SqliteStore;            // undefined when indexer disabled for this chain
  stakingClient?: StakingClient;  // undefined when indexer disabled
  indexer?: MetadataIndexer;      // source of chain head + reorg buffer for sync status
  settlementIndexer?: SettlementIndexer;
  chainId?: string;               // used to look up the indexer checkpoint
  contractAddress?: string;       // contract whose checkpoint to expose
  channelsContractAddress?: string;
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

async function resolveAgentId(
  client: StakingClient,
  address: string | null | undefined,
): Promise<number | null> {
  if (!address) return null;
  const key = address.toLowerCase();
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
  const { poller, store, stakingClient, indexer, settlementIndexer, chainId, contractAddress, channelsContractAddress, port = 4000 } = deps;
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

    const enrichedPeers = await Promise.all(
      snapshot.peers.map(async (peer) => {
        // peerId is the lowercased seller EVM address without the 0x prefix.
        const peerId = (peer as { peerId?: string }).peerId;
        const address = peerId ? `0x${peerId}` : null;
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

    res.json({
      ...snapshot,
      peers: enrichedPeers,
      ...(indexerPayload ? { indexer: indexerPayload } : {}),
    });
  });

  /**
   * GET /leaderboard?role=seller|buyer&period=day|month|all&date=YYYY-MM-DD&limit=50
   *
   * Returns a ranked list of sellers or buyers by USDC volume for the given period.
   */
  app.get('/leaderboard', (req, res) => {
    if (!store) {
      res.status(503).json({ error: 'Settlement indexer not configured' });
      return;
    }

    const role = req.query['role'] as string | undefined;
    if (role !== 'seller' && role !== 'buyer') {
      res.status(400).json({ error: 'role must be "seller" or "buyer"' });
      return;
    }

    const period = (req.query['period'] as string | undefined) ?? 'all';
    if (period !== 'day' && period !== 'month' && period !== 'all') {
      res.status(400).json({ error: 'period must be "day", "month", or "all"' });
      return;
    }

    const limitStr = req.query['limit'] as string | undefined;
    const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200) : 50;

    let date: Date | undefined;
    const dateStr = req.query['date'] as string | undefined;
    if (dateStr) {
      const parsed = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        return;
      }
      date = parsed;
    }

    const entries = store.getLeaderboard(role as LeaderboardRole, period as LeaderboardPeriod, date, limit);

    // Include settlement indexer sync status if available
    const settlementCheckpoint = channelsContractAddress && chainId
      ? store.getCheckpointInfo(chainId, channelsContractAddress.toLowerCase())
      : null;
    const settlementHead = settlementIndexer?.getChainHead();
    const indexerStatus = settlementCheckpoint
      ? {
          ...settlementCheckpoint,
          ...(settlementHead?.latestBlock != null
            ? {
                latestBlock: settlementHead.latestBlock,
                synced: settlementCheckpoint.lastBlock >= settlementHead.latestBlock - settlementHead.reorgSafetyBlocks,
              }
            : {}),
        }
      : null;

    res.json({
      role,
      period,
      ...(dateStr ? { date: dateStr } : {}),
      entries,
      ...(indexerStatus ? { indexer: indexerStatus } : {}),
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
          console.log(`[network-stats] HTTP server listening on port ${port}`);
          resolve();
        });
      }),
    stop: () => {
      server?.close();
    },
  };
}
