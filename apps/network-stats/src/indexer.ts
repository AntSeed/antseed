import { ethers } from 'ethers';
import type { StatsClient } from '@antseed/node';
import type { SqliteStore } from './store.js';

export interface MetadataIndexerOptions {
  store: SqliteStore;
  statsClient: Pick<StatsClient, 'getMetadataRecordedEvents' | 'getBlockNumber'>;
  chainId: string;              // e.g. 'base-mainnet'
  contractAddress: string;      // lowercased externally — indexer stores as-is
  deployBlock: number;          // one-time seed for cold start
  tickIntervalMs: number;       // e.g. 60_000
  reorgSafetyBlocks: number;    // e.g. 12
  maxBlocksPerTick?: number;    // optional cap to bound eth_getLogs range (default 2_000)
  // When set, the indexer fetches block headers for event blocks and threads
  // their timestamps into applyBatch, so first_seen_at reflects on-chain wall
  // clock. Omitted in unit tests that mock the stats client.
  rpcUrl?: string;
}

function logError(err: unknown): void {
  console.error('[indexer] error:', err);
}

export class MetadataIndexer {
  private readonly _store: SqliteStore;
  private readonly _statsClient: Pick<StatsClient, 'getMetadataRecordedEvents' | 'getBlockNumber'>;
  private readonly _chainId: string;
  private readonly _contractAddress: string;
  private readonly _deployBlock: number;
  private readonly _tickIntervalMs: number;
  private readonly _reorgSafetyBlocks: number;
  private readonly _maxBlocksPerTick: number;
  private readonly _provider: ethers.JsonRpcProvider | undefined;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _running = false;
  private _latestBlock: number | null = null;

  constructor(options: MetadataIndexerOptions) {
    if (options.deployBlock < 0) {
      throw new Error('deployBlock must be >= 0');
    }
    if (options.tickIntervalMs <= 0) {
      throw new Error('tickIntervalMs must be > 0');
    }

    this._store = options.store;
    this._statsClient = options.statsClient;
    this._chainId = options.chainId;
    this._contractAddress = options.contractAddress;
    this._deployBlock = options.deployBlock;
    this._tickIntervalMs = options.tickIntervalMs;
    this._reorgSafetyBlocks = options.reorgSafetyBlocks;

    const provided = options.maxBlocksPerTick;
    this._maxBlocksPerTick = (provided !== undefined && provided > 0) ? provided : 2_000;

    this._provider = options.rpcUrl ? new ethers.JsonRpcProvider(options.rpcUrl) : undefined;
  }

  start(): void {
    // Run one tick immediately (defensive catch — tick already catches internally)
    void this.tick().catch(logError);

    this._timer = setInterval(() => void this.tick().catch(logError), this._tickIntervalMs);
  }

  stop(): void {
    clearInterval(this._timer);
  }

  /**
   * Returns the chain head observed on the most recent tick plus the
   * indexer's reorg safety buffer. Null latestBlock means no tick has run
   * yet (process just started and the first eth_blockNumber is still in flight).
   */
  getChainHead(): { latestBlock: number | null; reorgSafetyBlocks: number } {
    return { latestBlock: this._latestBlock, reorgSafetyBlocks: this._reorgSafetyBlocks };
  }

  /**
   * Exposed for tests — runs one iteration end-to-end. Never throws out.
   *
   * Re-entrancy guard: if a prior tick is still in flight (slow RPC), the next
   * interval fire short-circuits. Without this, two concurrent ticks would read
   * the same checkpoint, fetch the same block range, and both apply deltas —
   * permanently doubling every affected agent's cumulative totals.
   */
  async tick(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const latest = await this._statsClient.getBlockNumber();
      this._latestBlock = latest;
      const safeTo = latest - this._reorgSafetyBlocks;

      if (safeTo < this._deployBlock) {
        return;
      }

      const checkpoint = this._store.getCheckpoint(this._chainId, this._contractAddress);
      const fromBlock = checkpoint === null ? this._deployBlock : checkpoint + 1;

      if (fromBlock > safeTo) {
        return;
      }

      const toBlock = Math.min(safeTo, fromBlock + this._maxBlocksPerTick - 1);

      const events = await this._statsClient.getMetadataRecordedEvents({ fromBlock, toBlock });

      // Fetch block timestamps for each distinct block that carried an event,
      // so applyBatch can stamp first_seen_at with on-chain wall clock. Only
      // distinct blocks matter — a block with N events costs one getBlock call.
      let blockTimestamps: Map<number, number> | undefined;
      if (this._provider && events.length > 0) {
        const uniqueBlocks = Array.from(new Set(events.map((e) => e.blockNumber)));
        const blocks = await Promise.all(uniqueBlocks.map((b) => this._provider!.getBlock(b)));
        blockTimestamps = new Map();
        for (let i = 0; i < uniqueBlocks.length; i++) {
          const block = blocks[i];
          if (block) blockTimestamps.set(uniqueBlocks[i]!, block.timestamp);
        }
      }

      // Always capture the checkpoint block's wall-clock so /stats can show
      // how fresh the indexer is. Reuse the timestamp from the event-block
      // fetch above if toBlock happened to carry an event, otherwise one
      // extra getBlock call.
      let newCheckpointTimestamp: number | null = null;
      if (this._provider) {
        if (blockTimestamps?.has(toBlock)) {
          newCheckpointTimestamp = blockTimestamps.get(toBlock)!;
        } else {
          const block = await this._provider.getBlock(toBlock);
          newCheckpointTimestamp = block?.timestamp ?? null;
        }
      }

      this._store.applyBatch(
        this._chainId,
        this._contractAddress,
        events,
        toBlock,
        blockTimestamps,
        newCheckpointTimestamp,
      );

      console.log(`[indexer] ${fromBlock}..${toBlock} events=${events.length}`);
    } catch (err) {
      console.error('[indexer] tick error:', err);
    } finally {
      this._running = false;
    }
  }
}
