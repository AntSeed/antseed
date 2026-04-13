/**
 * Express HTTP server — exposes network stats for XHR consumption.
 *
 * GET /stats  →  { peers: PeerMetadata[], updatedAt }
 * GET /health →  { ok: true }
 */

import express from 'express';
import type { NetworkPoller } from './poller.js';
import type { StakingClient } from '@antseed/node';
import type { SqliteStore } from './store.js';

export interface CreateServerDeps {
  poller: NetworkPoller;
  store?: SqliteStore;            // undefined when indexer disabled for this chain
  stakingClient?: StakingClient;  // undefined when indexer disabled
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
  const { poller, store, stakingClient, port = 4000 } = deps;
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
        const agentId = await resolveAgentId(stakingClient, (peer as { publicAddress?: string }).publicAddress);
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
            avgRequestsPerChannel: totals.avgRequestsPerChannel,
            avgRequestsPerBuyer: totals.avgRequestsPerBuyer,
            lastUpdatedAt: totals.lastUpdatedAt,
          },
        };
      }),
    );

    res.json({ ...snapshot, peers: enrichedPeers });
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
