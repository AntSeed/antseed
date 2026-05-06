/**
 * Backfill `network_history` from on-chain events.
 *
 * The forward poller writes one history row every minute, but for installs
 * that have been running for a while there's no past history to chart. This
 * one-shot routine re-fetches all `MetadataRecorded` events from the
 * contract's deploy block (or from the existing checkpoint, if resuming) to
 * the chain head, applies them to `seller_totals` via `store.applyBatch` in
 * UTC-day chunks, and records one synthetic history row per day from
 * `store.getNetworkTotals()` after each day's chunk is applied.
 *
 * Why share the applyBatch path with the live indexer? It guarantees a single
 * source of truth for cumulative counters: every row in `network_history`
 * (backfill, indexer-emitted, or live sampler) is read from the same
 * `seller_totals` aggregate, so the table is monotonic with respect to ts.
 * Without that, the backfill's in-memory cumulative could exceed the live
 * indexer's still-catching-up `seller_totals` sum, producing negative
 * velocity deltas in /insights.
 *
 * Backfill rows have `active_peers = ACTIVE_PEERS_UNKNOWN` (sentinel −1)
 * because the DHT peer count is not recoverable from chain — it's only
 * observable live. The bucketing layer translates the sentinel to null so
 * the chart's peers line simply doesn't render for those days.
 *
 * Caller contract: don't run the live indexer concurrently with the backfill,
 * or both will try to apply the same events to seller_totals (no event-level
 * dedup → double counting). `index.ts` defers `indexer.start()` until backfill
 * resolves.
 */

import type { StatsClient, DecodedMetadataRecorded } from '@antseed/node';
import { ACTIVE_PEERS_UNKNOWN, type SqliteStore } from '../store.js';
import {
  createProgressReporter,
  defaultLog,
  resolveBlockTimestamps,
  type BlockProvider,
} from '../utils.js';

export interface BackfillProgress {
  /** What the routine is doing right now. UI uses this to pick a label. */
  phase: 'scanning' | 'resolving-timestamps' | 'done';
  scannedBlocks: number;
  totalBlocks: number;
  events: number;
  rowsWritten: number;
}

export interface BackfillOptions {
  store: SqliteStore;
  statsClient: Pick<StatsClient, 'getMetadataRecordedEvents' | 'getBlockNumber'>;
  /**
   * Provider used to fetch block timestamps. Pass `statsClient.provider` so any
   * FallbackProvider failover configured on the client also covers this path —
   * a single 429 from the public Base RPC otherwise sticks the backfill into a
   * failed state for the rest of the process lifetime.
   */
  provider: BlockProvider;
  /** Chain id used to key the indexer checkpoint that backfill advances. */
  chainId: string;
  /** Stats contract whose checkpoint we read/advance. Lowercased internally. */
  contractAddress: string;
  /** Block where the stats contract was deployed; the lower bound of the scan. */
  deployBlock: number;
  /** Subtract this many blocks from the head before scanning, mirroring the indexer's reorg buffer. */
  reorgSafetyBlocks: number;
  /** Cap eth_getLogs window size; matches indexer's default of 2000. */
  maxBlocksPerChunk?: number;
  /** Per-chunk pause to avoid hammering rate-limited public RPCs. */
  chunkDelayMs?: number;
  /** Optional logger; defaults to console. */
  log?: (msg: string) => void;
  /** Fired after each chunk is scanned and once at the end so the UI can show a progress strip. */
  onProgress?: (progress: BackfillProgress) => void;
}

const DAY_SECONDS = 86_400;

export interface BackfillResult {
  scannedBlocks: number;
  events: number;
  rowsWritten: number;
}

/**
 * Run the backfill. Resumable: starts from `max(deployBlock, checkpoint+1)`
 * so a process killed mid-way picks up where it left off without
 * double-applying events. To force a fresh backfill on an existing DB,
 * `DELETE FROM network_history; DELETE FROM indexer_checkpoint; …` (and the
 * seller aggregate tables) before running.
 */
export async function backfillNetworkHistory(opts: BackfillOptions): Promise<BackfillResult> {
  const {
    store,
    statsClient,
    provider,
    chainId,
    contractAddress,
    deployBlock,
    reorgSafetyBlocks,
    maxBlocksPerChunk = 2_000,
    chunkDelayMs = 0,
    log = defaultLog,
  } = opts;

  const onProgress = opts.onProgress;
  const contract = contractAddress.toLowerCase();

  const head = await statsClient.getBlockNumber();
  const safeTo = head - reorgSafetyBlocks;
  const checkpoint = store.getCheckpoint(chainId, contract);
  const fromBlock = Math.max(deployBlock, (checkpoint ?? deployBlock - 1) + 1);

  if (safeTo < fromBlock) {
    onProgress?.({ phase: 'done', scannedBlocks: 0, totalBlocks: 0, events: 0, rowsWritten: 0 });
    return { scannedBlocks: 0, events: 0, rowsWritten: 0 };
  }

  const totalBlocks = safeTo - fromBlock + 1;
  log(`[backfill] scanning blocks ${fromBlock}..${safeTo} (chunkSize=${maxBlocksPerChunk})`);

  const progress = createProgressReporter({ prefix: '[backfill]', totalBlocks, log });

  // 1. Pull events in chunks, accumulate.
  const allEvents: DecodedMetadataRecorded[] = [];
  let scannedSoFar = 0;
  for (let from = fromBlock; from <= safeTo; from += maxBlocksPerChunk) {
    const to = Math.min(safeTo, from + maxBlocksPerChunk - 1);
    const events = await statsClient.getMetadataRecordedEvents({ fromBlock: from, toBlock: to });
    if (events.length > 0) {
      allEvents.push(...events);
    }
    scannedSoFar = to - fromBlock + 1;
    progress.draw(scannedSoFar, allEvents.length);
    onProgress?.({
      phase: 'scanning',
      scannedBlocks: scannedSoFar,
      totalBlocks,
      events: allEvents.length,
      rowsWritten: 0,
    });
    if (chunkDelayMs > 0 && to < safeTo) {
      await new Promise((r) => setTimeout(r, chunkDelayMs));
    }
  }
  // Always paint the final 100% state, then commit the in-place line so the
  // next phase's log() starts on a new row.
  progress.draw(scannedSoFar, allEvents.length, true);
  progress.finish();

  if (allEvents.length === 0) {
    log('[backfill] no events found — nothing to write');
    onProgress?.({
      phase: 'done',
      scannedBlocks: totalBlocks,
      totalBlocks,
      events: 0,
      rowsWritten: 0,
    });
    return { scannedBlocks: totalBlocks, events: 0, rowsWritten: 0 };
  }

  // 2. Resolve each unique block's timestamp. The settlement contract on Base
  //    fires a single event per settlement, but blocks bundle many txs, so
  //    deduping the block list before fetching keeps RPC cost down by a lot.
  const uniqueBlocks = Array.from(new Set(allEvents.map((e) => e.blockNumber)));
  log(`[backfill] resolving ${uniqueBlocks.length} block timestamps...`);
  onProgress?.({
    phase: 'resolving-timestamps',
    scannedBlocks: totalBlocks,
    totalBlocks,
    events: allEvents.length,
    rowsWritten: 0,
  });
  const { timestamps: blockTimestamps, failedCount: failedBlocks } =
    await resolveBlockTimestamps(provider, uniqueBlocks);
  if (failedBlocks > 0) {
    log(`[backfill] WARN: ${failedBlocks} block timestamp lookup(s) failed — those events will be skipped`);
  }

  // 3. Walk events in chronological order. For each UTC-day boundary we
  //    cross, atomically apply that day's events through the same code path
  //    the indexer uses (applyBatch advances seller_totals + checkpoint),
  //    then snapshot getNetworkTotals() into a network_history row. This
  //    means every row in network_history — backfill or live — is derived
  //    from the same cumulative counter, which keeps the table monotonic.
  //
  //    Events come back from getMetadataRecordedEvents() already sorted by
  //    (blockNumber, logIndex), and the chunk loop appends in block-order, so
  //    `allEvents` is globally sorted. No re-sort needed.
  let buffer: DecodedMetadataRecorded[] = [];
  let bufferDay: number | null = null;
  let bufferLastBlockTs = 0;
  let bufferLastBlock = 0;
  let rowsWritten = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    store.applyBatch(
      chainId,
      contract,
      buffer,
      bufferLastBlock,
      blockTimestamps,
      bufferLastBlockTs,
    );
    const totals = store.getNetworkTotals();
    const result = store.recordHistorySample({
      ts: bufferLastBlockTs,
      activePeers: ACTIVE_PEERS_UNKNOWN,
      sellerCount: totals.sellerCount,
      totalRequests: totals.totalRequests,
      totalInputTokens: totals.totalInputTokens,
      totalOutputTokens: totals.totalOutputTokens,
      settlementCount: totals.settlementCount,
    });
    if (result.written) rowsWritten++;
    buffer = [];
    bufferDay = null;
  };

  for (const ev of allEvents) {
    const blockTs = blockTimestamps.get(ev.blockNumber);
    if (blockTs === undefined) {
      log(`[backfill] WARN: missing block timestamp for ${ev.blockNumber}, skipping event`);
      continue;
    }
    const day = Math.floor(blockTs / DAY_SECONDS);
    if (bufferDay !== null && day !== bufferDay) {
      flush();
    }
    buffer.push(ev);
    bufferDay = day;
    bufferLastBlock = ev.blockNumber;
    bufferLastBlockTs = blockTs;
  }
  flush();

  log(`[backfill] done — events=${allEvents.length} rows=${rowsWritten}`);
  onProgress?.({
    phase: 'done',
    scannedBlocks: totalBlocks,
    totalBlocks,
    events: allEvents.length,
    rowsWritten,
  });

  return {
    scannedBlocks: totalBlocks,
    events: allEvents.length,
    rowsWritten,
  };
}
