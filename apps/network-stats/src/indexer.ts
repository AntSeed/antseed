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
  private _timer: ReturnType<typeof setInterval> | undefined;

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
  }

  start(): void {
    // Run one tick immediately (defensive catch — tick already catches internally)
    void this.tick().catch(logError);

    this._timer = setInterval(() => void this.tick().catch(logError), this._tickIntervalMs);
  }

  stop(): void {
    clearInterval(this._timer);
  }

  /** Exposed for tests — runs one iteration end-to-end. Never throws out. */
  async tick(): Promise<void> {
    try {
      const latest = await this._statsClient.getBlockNumber();
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

      this._store.applyBatch(this._chainId, this._contractAddress, events, toBlock);

      console.log(`[indexer] ${fromBlock}..${toBlock} events=${events.length}`);
    } catch (err) {
      console.error('[indexer] tick error:', err);
    }
  }
}
