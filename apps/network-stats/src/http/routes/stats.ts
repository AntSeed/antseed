import type { Express } from 'express';

import type { MetadataIndexer } from '../../indexers/metadata-indexer.js';
import type { NetworkPoller, NetworkSnapshot } from '../../poller.js';
import type { SqliteStore } from '../../store.js';
import { computeNetworkMetrics, type NetworkMetrics } from '../../metrics.js';
import { getPeerLookupAddress, snapshotUpdatedAtMs } from '../../utils.js';
import type { AgentIdCache } from '../agent-id-cache.js';
import { STATS_NETWORK_CACHE_KEY, STATS_PEERS_CACHE_KEY } from '../cache-keys.js';
import { asyncHandler } from '../middleware.js';
import {
  mergeEnvelopes,
  sendCachedJson,
  type ResponseCache,
} from '../response-cache.js';
import { serializeNetworkTotals, serializeOnChainStats } from '../serializers.js';
import type { BackfillStatusPayload } from '../types.js';

// /stats/network is cheap to compute (in-memory + a single SQLite read), but
// the dashboard polls it from every header strip/sidebar — caching collapses
// repeated work to one compute per indexer tick (writer invalidates) and
// gives ETag/304 free.
const NETWORK_FRESH_MS = 5_000;
const NETWORK_STALE_MS = 60_000;
// /stats/peers is the heavy branch (N agentId resolutions + N getSellerTotals).
// Wider freshness budget — the peer set only meaningfully changes on poll.
const PEERS_FRESH_MS = 30_000;
const PEERS_STALE_MS = 5 * 60_000;

export interface StatsRouteDeps {
  poller: NetworkPoller;
  store?: SqliteStore;
  agentIds?: AgentIdCache;
  indexer?: MetadataIndexer;
  chainId?: string;
  contractAddress?: string;
  getBackfillStatus?: () => BackfillStatusPayload;
  cache: ResponseCache;
}

interface NetworkPayload {
  updatedAt: string;
  network: NetworkMetrics;
  totals?: ReturnType<typeof serializeNetworkTotals>;
  indexer?: Record<string, unknown>;
  backfill?: BackfillStatusPayload;
}

interface PeersPayload {
  updatedAt: string;
  peers: NetworkSnapshot['peers'];
}

export function registerStatsRoutes(app: Express, deps: StatsRouteDeps): void {
  const { poller, store, agentIds, indexer, chainId, contractAddress, getBackfillStatus, cache } =
    deps;

  // Synchronous: in-memory snapshot + pure metrics + a single SQLite read for
  // the indexer checkpoint. No agentId fan-out, no per-seller lookups — this
  // is the cheap branch that the dashboard's header strip / sidebar can poll
  // freely.
  function buildNetworkPayload(snapshot: NetworkSnapshot): NetworkPayload {
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

  // Async: heavy branch. N agentId resolutions (cached) + N per-seller
  // `getSellerTotals` reads. When no store/agentIds are wired up the peers
  // come back unenriched — same shape as the legacy /stats fast path so
  // existing clients don't break.
  //
  // Returns `cacheable: false` when any agentId lookup returned null —
  // AgentIdCache only emits null on RPC failures (unstaked peers map to 0),
  // so a null marks a transient failure that shouldn't poison the slot.
  async function buildPeersPayload(
    snapshot: NetworkSnapshot,
  ): Promise<{ payload: PeersPayload; cacheable: boolean }> {
    if (!store || !agentIds) {
      return { payload: { updatedAt: snapshot.updatedAt, peers: snapshot.peers }, cacheable: true };
    }

    const peerLookupAddresses = snapshot.peers.map(getPeerLookupAddress);
    const { map: agentIdsByAddress, hadFailure } = await agentIds.resolveMany(peerLookupAddresses);

    const enrichedPeers = snapshot.peers.map((peer, index) => {
      const address = peerLookupAddresses[index] ?? null;
      const agentId = address ? agentIdsByAddress.get(address) ?? null : null;
      const totals = agentId && agentId !== 0 ? store.getSellerTotals(agentId) : null;
      const onChainStats = agentId && totals ? serializeOnChainStats(agentId, totals) : null;
      return { ...peer, onChainStats };
    });

    return {
      payload: { updatedAt: snapshot.updatedAt, peers: enrichedPeers },
      cacheable: !hadFailure,
    };
  }

  function loadNetworkEnvelope() {
    return cache.read<NetworkPayload>(STATS_NETWORK_CACHE_KEY, {
      compute: async () => {
        const snapshot = poller.getSnapshot();
        return { payload: buildNetworkPayload(snapshot), sourceUpdatedAt: snapshotUpdatedAtMs(snapshot) };
      },
      freshMs: NETWORK_FRESH_MS,
      staleMs: NETWORK_STALE_MS,
    });
  }

  function loadPeersEnvelope() {
    return cache.read<PeersPayload>(STATS_PEERS_CACHE_KEY, {
      compute: async () => {
        const snapshot = poller.getSnapshot();
        const { payload, cacheable } = await buildPeersPayload(snapshot);
        return { payload, sourceUpdatedAt: snapshotUpdatedAtMs(snapshot), cacheable };
      },
      freshMs: PEERS_FRESH_MS,
      staleMs: PEERS_STALE_MS,
    });
  }

  // Legacy union — kept for back-compat. New clients should fetch only the
  // sub-route(s) they render. /stats/network avoids the per-peer fan-out
  // entirely, which is the only reason the header strip can poll often.
  app.get('/stats', asyncHandler(async (req, res) => {
    const [networkEnv, peersEnv] = await Promise.all([loadNetworkEnvelope(), loadPeersEnvelope()]);
    sendCachedJson(req, res, mergeEnvelopes(networkEnv, peersEnv, (n, p) => ({ ...n, ...p })));
  }));

  app.get('/stats/network', asyncHandler(async (req, res) => {
    sendCachedJson(req, res, await loadNetworkEnvelope());
  }));

  app.get('/stats/peers', asyncHandler(async (req, res) => {
    sendCachedJson(req, res, await loadPeersEnvelope());
  }));
}
