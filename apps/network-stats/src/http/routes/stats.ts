import type { Express } from 'express';

import type { MetadataIndexer } from '../../indexer.js';
import type { NetworkPoller, NetworkSnapshot } from '../../poller.js';
import type { SqliteStore } from '../../store.js';
import { computeNetworkMetrics, type NetworkMetrics } from '../../metrics.js';
import { getPeerLookupAddress } from '../../utils.js';
import type { AgentIdCache } from '../agentIdCache.js';
import { asyncHandler } from '../middleware.js';
import { serializeNetworkTotals, serializeOnChainStats } from '../serializers.js';
import type { BackfillStatusPayload } from '../types.js';

export interface StatsRouteDeps {
  poller: NetworkPoller;
  store?: SqliteStore;
  agentIds?: AgentIdCache;
  indexer?: MetadataIndexer;
  chainId?: string;
  contractAddress?: string;
  getBackfillStatus?: () => BackfillStatusPayload;
}

export function registerStatsRoutes(app: Express, deps: StatsRouteDeps): void {
  const { poller, store, agentIds, indexer, chainId, contractAddress, getBackfillStatus } = deps;

  // Synchronous: in-memory snapshot + pure metrics + a single SQLite read for
  // the indexer checkpoint. No agentId fan-out, no per-seller lookups — this
  // is the cheap branch that the dashboard's header strip / sidebar can poll
  // freely.
  function loadNetworkPayload(snapshot: NetworkSnapshot): {
    updatedAt: string;
    network: NetworkMetrics;
    totals?: ReturnType<typeof serializeNetworkTotals>;
    indexer?: Record<string, unknown>;
    backfill?: BackfillStatusPayload;
  } {
    const network = computeNetworkMetrics(snapshot.peers);
    if (!store) {
      return { updatedAt: snapshot.updatedAt, network };
    }

    const indexerInfo =
      chainId && contractAddress
        ? store.getCheckpointInfo(chainId, contractAddress.toLowerCase())
        : null;

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

    return {
      updatedAt: snapshot.updatedAt,
      network,
      totals: serializeNetworkTotals(store.getNetworkTotals()),
      ...(indexerPayload ? { indexer: indexerPayload } : {}),
      ...(getBackfillStatus ? { backfill: getBackfillStatus() } : {}),
    };
  }

  // Async: this is the heavy branch. N agentId resolutions (cached) + N
  // per-seller `getSellerTotals` reads. When no store/agentIds are wired up
  // the peers come back unenriched — same shape as the legacy /stats fast
  // path so existing clients don't break.
  async function loadPeersPayload(snapshot: NetworkSnapshot): Promise<{
    updatedAt: string;
    peers: typeof snapshot.peers;
  }> {
    if (!store || !agentIds) {
      return { updatedAt: snapshot.updatedAt, peers: snapshot.peers };
    }

    const peerLookupAddresses = snapshot.peers.map(getPeerLookupAddress);
    const agentIdsByAddress = await agentIds.resolveMany(peerLookupAddresses);

    const enrichedPeers = snapshot.peers.map((peer, index) => {
      const address = peerLookupAddresses[index] ?? null;
      const agentId = address ? agentIdsByAddress.get(address) ?? null : null;
      const totals = agentId && agentId !== 0 ? store.getSellerTotals(agentId) : null;
      const onChainStats = agentId && totals ? serializeOnChainStats(agentId, totals) : null;
      return { ...peer, onChainStats };
    });

    return { updatedAt: snapshot.updatedAt, peers: enrichedPeers };
  }

  // Legacy union — kept for back-compat. New clients should fetch only the
  // sub-route(s) they render. /stats/network avoids the per-peer fan-out
  // entirely, which is the only reason the header strip can poll often.
  app.get('/stats', asyncHandler(async (_req, res) => {
    const snapshot = poller.getSnapshot();
    const networkPayload = loadNetworkPayload(snapshot);
    const peersPayload = await loadPeersPayload(snapshot);
    res.json({ ...networkPayload, ...peersPayload });
  }));

  app.get('/stats/network', (_req, res) => {
    res.json(loadNetworkPayload(poller.getSnapshot()));
  });

  app.get('/stats/peers', asyncHandler(async (_req, res) => {
    res.json(await loadPeersPayload(poller.getSnapshot()));
  }));
}
