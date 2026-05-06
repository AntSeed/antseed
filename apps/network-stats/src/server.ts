/**
 * Express HTTP server — exposes network stats for XHR consumption.
 *
 * GET /stats                    →  union of network + per-peer payload (legacy — kept for back-compat)
 * GET /stats/network            →  cheap: network metrics, totals, indexer, backfill (no per-peer fan-out)
 * GET /stats/peers              →  heavy: per-peer DHT snapshot enriched with on-chain totals
 * GET /insights                 →  union of all insight sections (legacy — kept for back-compat)
 * GET /insights/leaderboards    →  ranked-seller leaderboards
 * GET /insights/pricing         →  pricing market + stability + movers
 * GET /insights/services        →  service/protocol/provider rankings + regions + concentration
 * GET /insights/activity        →  live activity + 24h/7d velocity windows
 * GET /history                  →  bucketed time series, all fields (legacy — kept for back-compat)
 * GET /history/peers            →  bucketed time series, peer-activity fields only
 * GET /history/tokens           →  bucketed time series, tokens field only
 * GET /health                   →  liveness probe
 *
 * Routing, validation, and per-endpoint logic live under ./http. This file
 * owns wiring (DI), middleware order, and the start/stop lifecycle only.
 */

import express from 'express';
import type { StakingClient } from '@antseed/node';

import type { MetadataIndexer } from './indexers/metadata-indexer.js';
import type { NetworkPoller } from './poller.js';
import type { SqliteStore } from './store.js';
import { AgentIdCache } from './http/agent-id-cache.js';
import { corsMiddleware, errorHandler } from './http/middleware.js';
import { InProcessResponseCache, type ResponseCache } from './http/response-cache.js';
import { registerAntsRoutes } from './http/routes/ants.js';
import { registerEventsRoutes } from './http/routes/events.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { registerHistoryRoutes } from './http/routes/history.js';
import { registerInsightsRoutes } from './http/routes/insights.js';
import { registerReputationRoutes } from './http/routes/reputation.js';
import { registerStatsRoutes } from './http/routes/stats.js';
import type { BackfillStatusPayload } from './http/types.js';

export type { BackfillStatusPayload } from './http/types.js';

export interface CreateServerDeps {
  poller: NetworkPoller;
  store?: SqliteStore;            // undefined when indexer disabled for this chain
  stakingClient?: StakingClient;  // undefined when indexer disabled
  indexer?: MetadataIndexer;      // source of chain head + reorg buffer for sync status
  chainId?: string;               // used to look up the indexer checkpoint
  contractAddress?: string;       // contract whose checkpoint to expose
  /** Lowercased ANTS token contract address — scopes /ants/transfers when indexed. */
  antsContractAddress?: string;
  getBackfillStatus?: () => BackfillStatusPayload;
  port?: number;
}

export interface ServerHandle {
  start(): Promise<void>;
  stop(): void;
  /**
   * Materialized read-model cache, exposed so the bootstrap layer can wire
   * writer-event invalidation (poller / indexer / sampler) without coupling
   * those modules to the cache directly.
   */
  cache: ResponseCache;
}

export function createServer(deps: CreateServerDeps): ServerHandle {
  const {
    poller, store, stakingClient, indexer, chainId, contractAddress,
    antsContractAddress, getBackfillStatus, port = 4000,
  } = deps;
  const app = express();

  // Per-server cache shared across /stats and /insights so a single agentId
  // resolution serves both endpoints. Per-instance by design — keeps tests
  // and colocated servers isolated.
  const agentIds = stakingClient ? new AgentIdCache(stakingClient) : undefined;
  // Materialized read-model cache. One slot per route family (currently only
  // /insights/*; stats/history migrate next). Per-instance by design so
  // colocated test servers don't share state. Becomes a Redis-backed impl
  // (same `ResponseCache` interface) when this service goes multi-instance.
  const responseCache = new InProcessResponseCache();

  app.use(corsMiddleware);

  registerHealthRoutes(app);
  registerStatsRoutes(app, {
    poller,
    ...(store ? { store } : {}),
    ...(agentIds ? { agentIds } : {}),
    ...(indexer ? { indexer } : {}),
    ...(chainId ? { chainId } : {}),
    ...(contractAddress ? { contractAddress } : {}),
    ...(getBackfillStatus ? { getBackfillStatus } : {}),
    cache: responseCache,
  });
  registerInsightsRoutes(app, {
    poller,
    ...(store ? { store } : {}),
    ...(agentIds ? { agentIds } : {}),
    cache: responseCache,
  });
  registerHistoryRoutes(app, {
    ...(store ? { store } : {}),
    cache: responseCache,
  });
  registerEventsRoutes(app, {
    ...(store ? { store } : {}),
    cache: responseCache,
  });
  registerAntsRoutes(app, {
    ...(store ? { store } : {}),
    ...(antsContractAddress ? { antsContractAddress: antsContractAddress.toLowerCase() } : {}),
    cache: responseCache,
  });
  registerReputationRoutes(app, {
    ...(store ? { store } : {}),
    cache: responseCache,
  });

  app.use(errorHandler);

  let server: ReturnType<typeof app.listen> | null = null;

  return {
    cache: responseCache,
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
