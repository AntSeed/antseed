/**
 * Backfill `network_history` from on-chain events.
 *
 * The forward poller writes one history row every minute, but for installs
 * that have been running for a while there's no past history to chart. This
 * one-shot routine re-fetches all `MetadataRecorded` events from the
 * contract's deploy block to the chain head, walks them in order while
 * accumulating cumulative totals + a unique-seller set, and writes one
 * synthetic history row per UTC day.
 *
 * Backfill rows have `active_peers = ACTIVE_PEERS_UNKNOWN` (sentinel −1)
 * because the DHT peer count is not recoverable from chain — it's only
 * observable live. The bucketing layer translates the sentinel to null so
 * the chart's peers line simply doesn't render for those days.
 */

import type { StatsClient, DecodedMetadataRecorded } from '@antseed/node';
import { ACTIVE_PEERS_UNKNOWN, type SqliteStore } from './store.js';

/** Minimal slice of ethers.AbstractProvider we need — just block timestamps. */
interface BlockProvider {
  getBlock(blockNumber: number): Promise<{ timestamp: number } | null>;
}

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
 * Run the backfill. Idempotent — re-running adds no new rows because each
 * day's PK (ts) is the timestamp of the last event of that day; the second
 * run rewrites the same `ts → cumulative` pairs and INSERT OR IGNORE drops
 * them. To force a fresh backfill, `DELETE FROM network_history`.
 */
export async function backfillNetworkHistory(opts: BackfillOptions): Promise<BackfillResult> {
  const {
    store,
    statsClient,
    provider,
    deployBlock,
    reorgSafetyBlocks,
    maxBlocksPerChunk = 2_000,
    chunkDelayMs = 0,
    log = (msg) => console.log(msg),
  } = opts;

  const onProgress = opts.onProgress;

  const head = await statsClient.getBlockNumber();
  const safeTo = head - reorgSafetyBlocks;
  if (safeTo < deployBlock) {
    onProgress?.({ phase: 'done', scannedBlocks: 0, totalBlocks: 0, events: 0, rowsWritten: 0 });
    return { scannedBlocks: 0, events: 0, rowsWritten: 0 };
  }

  const totalBlocks = safeTo - deployBlock + 1;
  log(`[backfill] scanning blocks ${deployBlock}..${safeTo} (chunkSize=${maxBlocksPerChunk})`);

  // 1. Pull events in chunks, accumulate.
  const allEvents: DecodedMetadataRecorded[] = [];
  let scannedSoFar = 0;
  for (let from = deployBlock; from <= safeTo; from += maxBlocksPerChunk) {
    const to = Math.min(safeTo, from + maxBlocksPerChunk - 1);
    const events = await statsClient.getMetadataRecordedEvents({ fromBlock: from, toBlock: to });
    if (events.length > 0) {
      log(`[backfill] ${from}..${to} events=${events.length}`);
      allEvents.push(...events);
    }
    scannedSoFar = to - deployBlock + 1;
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
  const blockTimestamps = new Map<number, number>();
  // Fetch in small parallel batches — public RPCs throttle at ~10 concurrent
  // calls. Use Promise.allSettled so a transient failure on one block doesn't
  // throw away the rest of the batch; events whose block timestamp is missing
  // are skipped at write time with a warning.
  const BATCH = 8;
  let failedBlocks = 0;
  for (let i = 0; i < uniqueBlocks.length; i += BATCH) {
    const slice = uniqueBlocks.slice(i, i + BATCH);
    const settled = await Promise.allSettled(slice.map((b) => provider.getBlock(b)));
    for (let j = 0; j < slice.length; j++) {
      const result = settled[j]!;
      if (result.status === 'fulfilled' && result.value) {
        blockTimestamps.set(slice[j]!, result.value.timestamp);
      } else {
        failedBlocks++;
      }
    }
  }
  if (failedBlocks > 0) {
    log(`[backfill] WARN: ${failedBlocks} block timestamp lookup(s) failed — those events will be skipped`);
  }

  // 3. Walk events in chronological order, accumulating cumulative totals
  //    and a unique-seller set. At every UTC day boundary crossing, capture
  //    the closing snapshot for that day.
  //
  //    Events come back from getMetadataRecordedEvents() already sorted by
  //    (blockNumber, logIndex), and the chunk loop appends in block-order, so
  //    `allEvents` is globally sorted. No re-sort needed.
  const closingByDay = new Map<number, {
    ts: number;
    cumRequests: bigint;
    cumInputTokens: bigint;
    cumOutputTokens: bigint;
    cumSettlements: number;
    sellerCount: number;
  }>();

  let cumRequests = 0n;
  let cumInputTokens = 0n;
  let cumOutputTokens = 0n;
  let cumSettlements = 0;
  const sellers = new Set<number>();

  for (const ev of allEvents) {
    const blockTs = blockTimestamps.get(ev.blockNumber);
    if (blockTs === undefined) {
      log(`[backfill] WARN: missing block timestamp for ${ev.blockNumber}, skipping event`);
      continue;
    }

    cumRequests += ev.requestCount;
    cumInputTokens += ev.inputTokens;
    cumOutputTokens += ev.outputTokens;
    cumSettlements += 1;
    if (ev.agentId <= BigInt(Number.MAX_SAFE_INTEGER)) {
      sellers.add(Number(ev.agentId));
    }

    const dayBucket = Math.floor(blockTs / DAY_SECONDS);
    closingByDay.set(dayBucket, {
      ts: blockTs,
      cumRequests,
      cumInputTokens,
      cumOutputTokens,
      cumSettlements,
      sellerCount: sellers.size,
    });
  }

  // 4. Persist one synthetic row per day. We use the timestamp of the day's
  //    LAST event as the row's ts — that puts the closing snapshot at the
  //    right end of its bucket, and (because each event has a unique block
  //    timestamp at second resolution) avoids PK collisions across days.
  let rowsWritten = 0;
  for (const day of closingByDay.values()) {
    store.recordHistorySample({
      ts: day.ts,
      activePeers: ACTIVE_PEERS_UNKNOWN,
      sellerCount: day.sellerCount,
      totalRequests: day.cumRequests,
      totalInputTokens: day.cumInputTokens,
      totalOutputTokens: day.cumOutputTokens,
      settlementCount: day.cumSettlements,
    });
    rowsWritten++;
  }

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
