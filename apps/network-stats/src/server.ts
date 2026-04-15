/**
 * Express HTTP server — exposes network stats for XHR consumption.
 *
 * GET /stats  →  { peers: PeerMetadata[], updatedAt }
 * GET /health →  { ok: true }
 */

import express from 'express';
import { isAddress } from 'ethers';
import type { NetworkPoller } from './poller.js';
import type { StakingClient } from '@antseed/node';
import type { SqliteStore } from './store.js';
import type { MetadataIndexer } from './indexer.js';

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

  app.get('/stats/buyer/:address', async (req, res) => {
    const raw = String(req.params.address ?? '');
    if (!isAddress(raw)) {
      res.status(400).json({ error: 'Invalid buyer address' });
      return;
    }
    const rawAddress = raw.toLowerCase();

    if (!store) {
      res.status(503).json({ error: 'Indexer not configured for this instance' });
      return;
    }

    const totals = store.getBuyerTotals(rawAddress);
    const perSeller = store.getBuyerPerSellerBreakdown(rawAddress);

    // Enrich per-seller rows with peer metadata (peerId + anything else the
    // poller exposes). We do a single pass over the snapshot peers, look up
    // each one's agentId via resolveAgentId (cached), and build an
    // agentId → peer map. Then join.
    const snapshot = poller.getSnapshot();
    const peerByAgentId = new Map<number, Record<string, unknown>>();
    if (stakingClient) {
      await Promise.all(
        snapshot.peers.map(async (peer) => {
          const peerId = (peer as { peerId?: string }).peerId;
          const address = peerId ? `0x${peerId}` : null;
          const agentId = await resolveAgentId(stakingClient, address);
          if (agentId !== null && agentId !== 0) {
            peerByAgentId.set(agentId, peer as unknown as Record<string, unknown>);
          }
        }),
      );
    }

    const bySeller = perSeller.map((row) => {
      const peer = peerByAgentId.get(row.agentId);
      const peerId = peer?.peerId as string | undefined;
      return {
        agentId: row.agentId,
        peerId: peerId ?? null,
        publicAddress: peerId ? `0x${peerId}` : null,
        totalRequests:     row.totalRequests.toString(),
        totalInputTokens:  row.totalInputTokens.toString(),
        totalOutputTokens: row.totalOutputTokens.toString(),
        settlementCount:   row.settlementCount,
        firstBlock:        row.firstBlock,
        lastBlock:         row.lastBlock,
      };
    });

    // Indexer info — mirror the shape from /stats so consumers can reuse logic.
    const indexerInfo =
      chainId && contractAddress
        ? store.getCheckpointInfo(chainId, contractAddress.toLowerCase())
        : null;
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
      buyer: rawAddress,
      totals: totals
        ? {
            totalRequests:     totals.totalRequests.toString(),
            totalInputTokens:  totals.totalInputTokens.toString(),
            totalOutputTokens: totals.totalOutputTokens.toString(),
            totalSettlements:  totals.totalSettlements,
            uniqueSellers:     totals.uniqueSellers,
            firstBlock:        totals.firstBlock,
            lastBlock:         totals.lastBlock,
          }
        : null,
      bySeller,
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
          console.log(`[network-stats] HTTP server listening on port ${port}`);
          resolve();
        });
      }),
    stop: () => {
      server?.close();
    },
  };
}
