import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { StakingClient, StatsClient, resolveChainConfig } from '@antseed/node';

// Load `.env.local` from the package root if present, before reading any
// env vars below. Silent when the file is missing so fresh checkouts and
// production environments (which inject vars directly) keep working.
const envFile = resolve(process.cwd(), '.env.local');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

import { NetworkPoller } from './poller.js';
import { createServer } from './server.js';
import { SqliteStore } from './store.js';
import { MetadataIndexer } from './indexer.js';
import { backfillNetworkHistory, type BackfillProgress } from './backfill.js';
import { HistorySampler } from './sampler.js';
import {
  INSIGHTS_CACHE_KEY,
  STATS_NETWORK_CACHE_KEY,
  STATS_PEERS_CACHE_KEY,
  historyCacheKey,
} from './http/cacheKeys.js';
import type { BackfillStatusPayload } from './http/types.js';

// ── env-driven config ──────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);
const CACHE_PATH = process.env['CACHE_PATH'];
const CHAIN_ID = process.env['NETWORK_STATS_CHAIN_ID'] ?? 'base-mainnet';
const DB_PATH = process.env['NETWORK_STATS_DB_PATH'] ?? 'data/network-stats.sqlite';
const RPC_URL_OVERRIDE = process.env['NETWORK_STATS_RPC_URL'];
const TICK_INTERVAL_MS = parseInt(process.env['NETWORK_STATS_TICK_INTERVAL_MS'] ?? '60000', 10);
const MAX_BLOCKS_PER_TICK = parseInt(process.env['NETWORK_STATS_MAX_BLOCKS_PER_TICK'] ?? '2000', 10);
const REORG_SAFETY_BLOCKS = 12;
// Backfill scans the entire chain history once on startup. Public Base RPCs
// typically rate-limit at a few hundred eth_getLogs/min — at 2000 blocks per
// chunk and ~12.5M blocks over a month, that's thousands of chunks fired in
// a tight loop. Smaller chunks + a short delay between them keeps the
// indexer's normal ticks from getting throttled out.
const BACKFILL_BLOCKS_PER_CHUNK = parseInt(
  process.env['NETWORK_STATS_BACKFILL_BLOCKS_PER_CHUNK'] ?? '5000',
  10,
);
const BACKFILL_CHUNK_DELAY_MS = parseInt(
  process.env['NETWORK_STATS_BACKFILL_CHUNK_DELAY_MS'] ?? '250',
  10,
);
// History samples are recorded on this cadence in addition to per-poll. The
// poller runs every 15 min, which is too sparse for 1d/7d charts to populate
// quickly after a fresh deploy. Sampling every minute means the chart fills
// in within hours instead of days; bucket aggregation downsamples for display.
const HISTORY_SAMPLE_INTERVAL_MS = parseInt(
  process.env['NETWORK_STATS_HISTORY_SAMPLE_INTERVAL_MS'] ?? '60000',
  10,
);
// Skip the full chain backfill if we already have ≥6h of history.
const BACKFILL_REFRESH_THRESHOLD_SEC = 6 * 3600;

// ── chain wiring (or null when the indexer is disabled for this chain) ────

interface ChainServices {
  store: SqliteStore;
  statsClient: StatsClient;
  stakingClient: StakingClient | null;
  indexer: MetadataIndexer;
  contractAddress: string;
  deployBlock: number;
}

function buildChainServices(): ChainServices | null {
  const chainConfig = resolveChainConfig({
    chainId: CHAIN_ID,
    ...(RPC_URL_OVERRIDE ? { rpcUrl: RPC_URL_OVERRIDE } : {}),
  });
  if (!chainConfig.statsContractAddress || typeof chainConfig.statsDeployBlock !== 'number') {
    console.log(
      `[network-stats] stats indexer disabled for chain ${CHAIN_ID} (no stats contract configured)`,
    );
    return null;
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const store = new SqliteStore(DB_PATH);
  store.init();

  const statsClient = new StatsClient({
    rpcUrl: chainConfig.rpcUrl,
    ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
    contractAddress: chainConfig.statsContractAddress,
  });

  const indexer = new MetadataIndexer({
    store,
    statsClient,
    chainId: CHAIN_ID,
    contractAddress: chainConfig.statsContractAddress.toLowerCase(),
    deployBlock: chainConfig.statsDeployBlock,
    tickIntervalMs: TICK_INTERVAL_MS,
    reorgSafetyBlocks: REORG_SAFETY_BLOCKS,
    maxBlocksPerTick: MAX_BLOCKS_PER_TICK,
    rpcUrl: chainConfig.rpcUrl,
  });

  let stakingClient: StakingClient | null = null;
  if (chainConfig.stakingContractAddress) {
    stakingClient = new StakingClient({
      rpcUrl: chainConfig.rpcUrl,
      ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
      contractAddress: chainConfig.stakingContractAddress,
      usdcAddress: chainConfig.usdcContractAddress,
      evmChainId: chainConfig.evmChainId,
    });
  } else {
    console.warn(`[network-stats] stats contract is configured for ${CHAIN_ID} but staking contract is not — /stats enrichment will fall back to the legacy non-enriched payload`);
  }

  return {
    store,
    statsClient,
    stakingClient,
    indexer,
    contractAddress: chainConfig.statsContractAddress,
    deployBlock: chainConfig.statsDeployBlock,
  };
}

// ── backfill status surface (polled by /stats) ─────────────────────────────

class BackfillTracker {
  private readonly status: BackfillStatusPayload = {
    state: 'idle',
    startedAt: null,
    finishedAt: null,
    scannedBlocks: 0,
    totalBlocks: 0,
    events: 0,
    rowsWritten: 0,
    phase: null,
    errorMessage: null,
  };

  start(): void {
    this.status.state = 'running';
    this.status.startedAt = Math.floor(Date.now() / 1000);
  }

  applyProgress(p: BackfillProgress): void {
    this.status.phase = p.phase;
    this.status.scannedBlocks = p.scannedBlocks;
    this.status.totalBlocks = p.totalBlocks;
    this.status.events = p.events;
    this.status.rowsWritten = p.rowsWritten;
    if (p.phase === 'done') {
      this.status.state = 'done';
      this.status.finishedAt = Math.floor(Date.now() / 1000);
    }
  }

  fail(err: unknown): void {
    this.status.state = 'failed';
    this.status.finishedAt = Math.floor(Date.now() / 1000);
    this.status.errorMessage = err instanceof Error ? err.message : String(err);
  }

  skip(): void {
    this.status.state = 'skipped';
  }

  /** Return a copy so a concurrent progress callback can't mutate the object mid-serialization. */
  snapshot(): BackfillStatusPayload {
    return { ...this.status };
  }
}

/**
 * Run the chain backfill in the background. Resolves once it's safe to start
 * the live indexer + history sampler — i.e. the backfill has finished writing
 * its backdated rows (success, failure, or "skipped because we already have
 * enough history"). Errors are logged but never fatal; the forward sampler
 * keeps running, and the user can always restart to retry.
 */
async function runBackfillIfNeeded(
  services: ChainServices,
  tracker: BackfillTracker,
): Promise<void> {
  const earliest = services.store.getEarliestHistoryTs();
  const nowSec = Math.floor(Date.now() / 1000);
  const fresh = earliest !== null && nowSec - earliest < BACKFILL_REFRESH_THRESHOLD_SEC;
  if (fresh) {
    tracker.skip();
    console.log(`[network-stats] history already extends back ${nowSec - earliest}s — skipping chain backfill`);
    return;
  }

  tracker.start();
  try {
    await backfillNetworkHistory({
      store: services.store,
      statsClient: services.statsClient,
      // Reuse the StatsClient's provider so any FallbackProvider failover
      // configured for normal indexing also covers the backfill.
      provider: services.statsClient.provider,
      chainId: CHAIN_ID,
      contractAddress: services.contractAddress,
      deployBlock: services.deployBlock,
      reorgSafetyBlocks: REORG_SAFETY_BLOCKS,
      maxBlocksPerChunk: BACKFILL_BLOCKS_PER_CHUNK,
      chunkDelayMs: BACKFILL_CHUNK_DELAY_MS,
      onProgress: (p) => tracker.applyProgress(p),
    });
  } catch (err) {
    console.error('[network-stats] backfill failed:', err);
    tracker.fail(err);
  }
}

// ── bootstrap ──────────────────────────────────────────────────────────────

const poller = new NetworkPoller(CACHE_PATH);
const chain = buildChainServices();
const backfillTracker = new BackfillTracker();
const sampler = chain
  ? new HistorySampler(chain.store, () => poller.getSnapshot().peers.length, HISTORY_SAMPLE_INTERVAL_MS)
  : null;

const server = createServer({
  poller,
  ...(chain ? { store: chain.store } : {}),
  ...(chain?.stakingClient ? { stakingClient: chain.stakingClient } : {}),
  ...(chain ? { indexer: chain.indexer } : {}),
  ...(chain ? { chainId: CHAIN_ID, contractAddress: chain.contractAddress } : {}),
  getBackfillStatus: () => backfillTracker.snapshot(),
  port: PORT,
});

// Wire background-writer hooks. Each producer (poller/indexer/sampler) calls
// its own listener after a successful write; this file is the one place that
// maps producers → cache slots so the relationships are grep-able.
//
// The poller's onPollComplete also delivers price/peer-count samples to the
// sampler — the assignment below is the merged behavior, not just cache
// invalidation, which is why it's a single function not a composed chain.
poller.onPollComplete = (snapshot) => {
  sampler?.onPollComplete(snapshot);
  // Peer set + region/provider mix changed → both /stats slots and the
  // services/regions/concentration sections of /insights are stale.
  server.cache.invalidate(STATS_NETWORK_CACHE_KEY);
  server.cache.invalidate(STATS_PEERS_CACHE_KEY);
  server.cache.invalidate(INSIGHTS_CACHE_KEY);
};

if (chain) {
  chain.indexer.onTickComplete = ({ eventCount }) => {
    // Every tick — even empty — advances indexer health (lastSuccessAt,
    // latestBlock, synced) which /stats/network surfaces.
    server.cache.invalidate(STATS_NETWORK_CACHE_KEY);
    // Totals-driven slots only need bumping when the tick actually wrote
    // events. Skipping no-op invalidations keeps a fully-caught-up indexer
    // from churning the cache once a minute.
    if (eventCount > 0) {
      server.cache.invalidate(STATS_PEERS_CACHE_KEY);
      server.cache.invalidate(INSIGHTS_CACHE_KEY);
    }
  };
}

if (sampler) {
  sampler.onSampleComplete = () => {
    // New history bucket → all three range slots advance, and insights
    // (velocity/activity windows) reads the same history source.
    server.cache.invalidate(historyCacheKey('1d'));
    server.cache.invalidate(historyCacheKey('7d'));
    server.cache.invalidate(historyCacheKey('30d'));
    server.cache.invalidate(INSIGHTS_CACHE_KEY);
  };
  sampler.start();
}

await server.start();
await poller.start();

// One-shot historical backfill from chain. We re-fetch all settlement events
// from the contract's deploy block (or the existing checkpoint, if resuming)
// to the chain head, applying them through `store.applyBatch` in UTC-day
// chunks. Backfill and the live indexer share the same applyBatch path so
// cumulative counters match — we therefore can't run them concurrently
// (no event-level dedup → double counting). The indexer is started AFTER
// backfill resolves; until then it sits idle while the backfill advances
// seller_totals + checkpoint to (head − reorgSafety).
if (chain) {
  // Don't await — backfill runs in the background. The sampler's "ts=now"
  // gate flips once backfill resolves so its rows can't race the backdated
  // ones from backfill.
  void runBackfillIfNeeded(chain, backfillTracker).finally(() => {
    sampler?.markBackfillResolved();
    chain.indexer.start();
  });
} else {
  // No chain wiring — nothing to run.
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(): void {
  console.log('[network-stats] shutting down...');
  sampler?.stop();
  chain?.indexer.stop();
  chain?.store.close();
  poller.stop();
  server.stop();
  process.exit(0);
}
