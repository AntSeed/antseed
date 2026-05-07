import { ethers } from 'ethers';
import type { ChannelsClient } from '@antseed/node';
import type { SqliteStore } from './store.js';

export interface ChannelsIndexerOptions {
  store: SqliteStore;
  channelsClient: Pick<ChannelsClient, 'getChannelEvents' | 'getBlockNumber'>;
  chainId: string;              // e.g. 'base-mainnet'
  contractAddress: string;      // canonical AntseedChannels address — lowercased externally
  deployBlock: number;          // one-time seed for cold start
  tickIntervalMs: number;       // e.g. 60_000
  reorgSafetyBlocks: number;    // e.g. 12
  maxBlocksPerTick?: number;    // default 2_000
  // Same shape as MetadataIndexer — when set, fetch block headers for each
  // event block so applyChannelBatch can stamp block_timestamp on rows for
  // windowed (24h/7d/30d) USDC reads.
  rpcUrl?: string;
}

function logError(err: unknown): void {
  console.error('[channels-indexer] error:', err);
}

/**
 * Indexer for AntseedChannels lifecycle events. Runs on the same tick cadence
 * as MetadataIndexer but with its own checkpoint row in `indexer_checkpoint`
 * (keyed on (chainId, channelsContractAddress)). The two indexers don't share
 * state and can advance independently.
 */
export class ChannelsIndexer {
  private readonly _store: SqliteStore;
  private readonly _client: Pick<ChannelsClient, 'getChannelEvents' | 'getBlockNumber'>;
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

  constructor(options: ChannelsIndexerOptions) {
    if (options.deployBlock < 0) {
      throw new Error('deployBlock must be >= 0');
    }
    if (options.tickIntervalMs <= 0) {
      throw new Error('tickIntervalMs must be > 0');
    }

    this._store = options.store;
    this._client = options.channelsClient;
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
    void this.tick().catch(logError);
    this._timer = setInterval(() => void this.tick().catch(logError), this._tickIntervalMs);
  }

  stop(): void {
    clearInterval(this._timer);
  }

  getChainHead(): { latestBlock: number | null; reorgSafetyBlocks: number } {
    return { latestBlock: this._latestBlock, reorgSafetyBlocks: this._reorgSafetyBlocks };
  }

  /**
   * One end-to-end iteration. Re-entrancy guard prevents two ticks from
   * overlapping if RPC is slow — without it, both would read the same
   * checkpoint, fetch the same range, and double-apply every event delta.
   */
  async tick(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const latest = await this._client.getBlockNumber();
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

      const events = await this._client.getChannelEvents({ fromBlock, toBlock });

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

      let newCheckpointTimestamp: number | null = null;
      if (this._provider) {
        if (blockTimestamps?.has(toBlock)) {
          newCheckpointTimestamp = blockTimestamps.get(toBlock)!;
        } else {
          const block = await this._provider.getBlock(toBlock);
          newCheckpointTimestamp = block?.timestamp ?? null;
        }
      }

      this._store.applyChannelBatch(
        this._chainId,
        this._contractAddress,
        events,
        toBlock,
        blockTimestamps,
        newCheckpointTimestamp,
      );

      console.log(`[channels-indexer] ${fromBlock}..${toBlock} events=${events.length}`);
    } catch (err) {
      console.error('[channels-indexer] tick error:', err);
    } finally {
      this._running = false;
    }
  }
}
