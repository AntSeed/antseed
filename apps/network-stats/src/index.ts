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

import { NetworkPoller, type NetworkSnapshot } from './poller.js';
import { createServer } from './server.js';
import { ACTIVE_PEERS_UNKNOWN, SqliteStore } from './store.js';
import { MetadataIndexer } from './indexer.js';
import { backfillNetworkHistory, type BackfillProgress } from './backfill.js';

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

const poller = new NetworkPoller(CACHE_PATH);

const chainConfig = resolveChainConfig({
  chainId: CHAIN_ID,
  ...(RPC_URL_OVERRIDE ? { rpcUrl: RPC_URL_OVERRIDE } : {}),
});
let store: SqliteStore | null = null;
let indexer: MetadataIndexer | null = null;
let stakingClient: StakingClient | null = null;
let statsClient: StatsClient | null = null;

if (chainConfig.statsContractAddress && typeof chainConfig.statsDeployBlock === 'number') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  store = new SqliteStore(DB_PATH);
  store.init();
  statsClient = new StatsClient({
    rpcUrl: chainConfig.rpcUrl,
    ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
    contractAddress: chainConfig.statsContractAddress,
  });
  indexer = new MetadataIndexer({
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
} else {
  console.log(
    `[network-stats] stats indexer disabled for chain ${CHAIN_ID} (no stats contract configured)`,
  );
}

// History sampling. We write a sample on:
//   - every successful poll (15 min cadence — captures a fresh peer count), and
//   - a fixed timer (1 min cadence — captures fresh request/settlement deltas
//     between polls so the chart populates quickly after a new deploy).
// Both write the same shape; INSERT OR IGNORE on the ts PK protects against
// the rare case where both fire in the same second.
//
// Both writers MUST wait for the chain backfill to settle. Backfill writes
// rows with backdated timestamps (one per UTC day in chain history); if a
// "ts=now" row lands first while backfill is still scanning, the table ends
// up non-monotonic in time order (past rows have larger cumulative totals
// than future ones), which breaks /insights velocity windows. The
// `backfillResolved` flag is flipped true once the backfill promise has
// settled (success, failure, or skipped) — see the backfill block below.
let historySampleTimer: ReturnType<typeof setInterval> | null = null;
let pollHasCompleted = false;
let backfillResolved = false;
// In-memory dedup cache for seller activity samples. Avoids issuing a
// SELECT+INSERT against seller_activity_history every minute for sellers
// whose totals haven't changed since the last sample. Bounded by the active
// seller set (we filter dormant sellers before this map), so unbounded
// growth is not a concern.
const lastActivitySigByAgent = new Map<number, string>();
const SELLER_ACTIVITY_WINDOW_SECONDS = 8 * 86400;

function recordHistorySampleNow(): void {
  if (!store) return;
  if (!backfillResolved) return;
  const tsSec = Math.floor(Date.now() / 1000);
  try {
    const snapshot = poller.getSnapshot();
    const totals = store.getNetworkTotals();
    // Until the first poll completes the DHT hasn't been observed, so
    // peers.length is structurally 0 — not 0-because-network-empty. Write
    // the sentinel so the chart renders null instead of a misleading zero.
    const activePeers = pollHasCompleted ? snapshot.peers.length : ACTIVE_PEERS_UNKNOWN;
    store.recordHistorySample({
      ts: tsSec,
      activePeers,
      sellerCount: totals.sellerCount,
      totalRequests: totals.totalRequests,
      totalInputTokens: totals.totalInputTokens,
      totalOutputTokens: totals.totalOutputTokens,
      settlementCount: totals.settlementCount,
    });
  } catch (err) {
    // Don't let a transient sqlite error (lock contention with the indexer,
    // disk pressure) tear down the timer or, worse, the process.
    console.error('[network-stats] recordHistorySample failed:', err);
  }

  // Per-seller activity samples. Two filters before the SQL fires:
  //   1. Skip sellers dormant past the trending window — trending only ever
  //      diffs the last 8 days, so a no-op row past that is wasted work.
  //   2. Skip sellers whose totals match the last signature we recorded —
  //      avoids a SELECT+(no-op-INSERT) per idle seller per minute.
  try {
    const activeCutoff = tsSec - SELLER_ACTIVITY_WINDOW_SECONDS;
    for (const seller of store.getAllSellerTotalsWithIds()) {
      if (seller.lastSeenAt === null || seller.lastSeenAt < activeCutoff) continue;
      const sig = `${seller.totalRequests}|${seller.totalInputTokens}|${seller.totalOutputTokens}|${seller.settlementCount}`;
      if (lastActivitySigByAgent.get(seller.agentId) === sig) continue;
      store.recordSellerActivitySample({
        agentId: seller.agentId,
        ts: tsSec,
        totalRequests: seller.totalRequests,
        totalInputTokens: seller.totalInputTokens,
        totalOutputTokens: seller.totalOutputTokens,
        settlementCount: seller.settlementCount,
      });
      lastActivitySigByAgent.set(seller.agentId, sig);
    }
  } catch (err) {
    console.error('[network-stats] recordSellerActivitySample failed:', err);
  }
}

/**
 * After every successful poll, walk the snapshot and record one price sample
 * per (peer, provider, service) the seller announced. The store dedups on
 * equal prices, so this is cheap when nothing changes — only actual price
 * movements end up as new rows.
 */
function recordPriceSamplesForSnapshot(snapshot: NetworkSnapshot): void {
  if (!store) return;
  const tsSec = Math.floor(Date.now() / 1000);
  try {
    for (const peer of snapshot.peers) {
      // peerId is already 40 hex lowercased without 0x — the canonical form.
      const peerId = typeof peer.peerId === 'string' ? peer.peerId : null;
      if (!peerId) continue;
      for (const provider of peer.providers) {
        for (const service of provider.services) {
          const specific = provider.servicePricing?.[service];
          const pricing = specific ?? provider.defaultPricing;
          if (!pricing) continue;
          const inputUsd = pricing.inputUsdPerMillion;
          const outputUsd = pricing.outputUsdPerMillion;
          if (typeof inputUsd !== 'number' || typeof outputUsd !== 'number') continue;
          store.recordPriceSample({
            peerId,
            provider: provider.provider,
            service,
            ts: tsSec,
            inputUsdPerMillion: inputUsd,
            outputUsdPerMillion: outputUsd,
            cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? null,
          });
        }
      }
    }
  } catch (err) {
    console.error('[network-stats] recordPriceSample failed:', err);
  }
}

if (store) {
  poller.onPollComplete = (snapshot) => {
    pollHasCompleted = true;
    // recordHistorySampleNow self-gates on backfillResolved. Price samples
    // are keyed by (peer, provider, service) and don't depend on cumulative
    // counters, so they're safe to record any time.
    recordHistorySampleNow();
    recordPriceSamplesForSnapshot(snapshot);
  };
  // Periodic sampling on the configured cadence. We deliberately do NOT write
  // an immediate startup sample here: on a fresh DB, getNetworkTotals() is
  // 0 before backfill applies any events, so an immediate sample would land a
  // ts=now/cum=0 row that gets sandwiched after the backdated backfill rows
  // once they're written. The first interval fire (60s in by default) is
  // enough lead time for the backfill to have touched at least one chunk.
  historySampleTimer = setInterval(recordHistorySampleNow, HISTORY_SAMPLE_INTERVAL_MS);
}

// Backfill status — exposed via /stats so the dashboard can show a sync strip
// while the chain history is being reconstructed. Updated in place by the
// onProgress callback below; null while we're deciding whether to run.
interface BackfillStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;            // unix sec
  finishedAt: number | null;           // unix sec
  scannedBlocks: number;
  totalBlocks: number;
  events: number;
  rowsWritten: number;
  phase: BackfillProgress['phase'] | null;
  errorMessage: string | null;
}
const backfillStatus: BackfillStatus = {
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
function getBackfillStatus(): BackfillStatus {
  // Return a copy so a concurrent progress callback can't mutate the object
  // mid-serialization in the express handler.
  return { ...backfillStatus };
}

const server = createServer({
  poller,
  ...(store ? { store } : {}),
  ...(stakingClient ? { stakingClient } : {}),
  ...(indexer ? { indexer } : {}),
  ...(store && chainConfig.statsContractAddress
    ? { chainId: CHAIN_ID, contractAddress: chainConfig.statsContractAddress }
    : {}),
  getBackfillStatus,
  port: PORT,
});

await server.start();
await poller.start();

// One-shot historical backfill from chain. We re-fetch all settlement events
// from the contract's deploy block (or the existing checkpoint, if resuming)
// and apply them through `store.applyBatch`, recording one network_history
// row per UTC day from `getNetworkTotals()`. Backfill and the live indexer
// share the same applyBatch path so cumulative counters match — we therefore
// can't run them concurrently (no event-level dedup → double counting). The
// indexer is started AFTER backfill resolves; until then it sits idle while
// the backfill advances seller_totals + checkpoint to (head − reorgSafety).
const BACKFILL_REFRESH_THRESHOLD_SEC = 6 * 3600; // skip if we already have ≥6h of history
if (
  store
  && statsClient
  && chainConfig.statsContractAddress
  && typeof chainConfig.statsDeployBlock === 'number'
) {
  const earliest = store.getEarliestHistoryTs();
  const nowSec = Math.floor(Date.now() / 1000);
  const needsBackfill = earliest === null || nowSec - earliest < BACKFILL_REFRESH_THRESHOLD_SEC;
  if (needsBackfill) {
    backfillStatus.state = 'running';
    backfillStatus.startedAt = nowSec;
    // Background — don't await. Failures are logged but never fatal; the
    // forward sampler keeps running, and the user can always restart to retry.
    // The indexer is started in `.finally` so it runs whether backfill
    // succeeded, failed, or did nothing.
    void backfillNetworkHistory({
      store,
      statsClient,
      // Reuse the StatsClient's provider so any FallbackProvider failover
      // configured for normal indexing also covers the backfill.
      provider: statsClient.provider,
      chainId: CHAIN_ID,
      contractAddress: chainConfig.statsContractAddress,
      deployBlock: chainConfig.statsDeployBlock,
      reorgSafetyBlocks: REORG_SAFETY_BLOCKS,
      maxBlocksPerChunk: BACKFILL_BLOCKS_PER_CHUNK,
      chunkDelayMs: BACKFILL_CHUNK_DELAY_MS,
      onProgress: (p) => {
        backfillStatus.phase = p.phase;
        backfillStatus.scannedBlocks = p.scannedBlocks;
        backfillStatus.totalBlocks = p.totalBlocks;
        backfillStatus.events = p.events;
        backfillStatus.rowsWritten = p.rowsWritten;
        if (p.phase === 'done') {
          backfillStatus.state = 'done';
          backfillStatus.finishedAt = Math.floor(Date.now() / 1000);
        }
      },
    }).catch((err: unknown) => {
      console.error('[network-stats] backfill failed:', err);
      backfillStatus.state = 'failed';
      backfillStatus.finishedAt = Math.floor(Date.now() / 1000);
      backfillStatus.errorMessage = err instanceof Error ? err.message : String(err);
    }).finally(() => {
      // Unblock the live history sampler — it's safe to write "ts=now" rows
      // now that backfill is no longer racing us with backdated writes.
      backfillResolved = true;
      indexer?.start();
    });
  } else {
    backfillStatus.state = 'skipped';
    console.log(`[network-stats] history already extends back ${nowSec - earliest}s — skipping chain backfill`);
    backfillResolved = true;
    indexer?.start();
  }
} else {
  // No store / no stats contract — indexer is null anyway, but guard for clarity.
  // No backfill ran, so the sampler can fire freely.
  backfillResolved = true;
  indexer?.start();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(): void {
  console.log('[network-stats] shutting down...');
  if (historySampleTimer !== null) clearInterval(historySampleTimer);
  indexer?.stop();
  store?.close();
  poller.stop();
  server.stop();
  process.exit(0);
}
