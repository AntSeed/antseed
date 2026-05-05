import { ethers } from 'ethers';
import type { StatsClient } from '@antseed/node';
import type { SqliteStore } from './store.js';
import { resolveBlockTimestamps } from './utils.js';

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

const DEFAULT_MAX_BLOCKS_PER_TICK = 2_000;

export interface IndexerHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
}

export interface ChainHead {
  latestBlock: number | null;
  reorgSafetyBlocks: number;
}

export class MetadataIndexer {
  private readonly store: SqliteStore;
  private readonly statsClient: Pick<StatsClient, 'getMetadataRecordedEvents' | 'getBlockNumber'>;
  private readonly chainId: string;
  private readonly contractAddress: string;
  private readonly deployBlock: number;
  private readonly tickIntervalMs: number;
  private readonly reorgSafetyBlocks: number;
  private readonly maxBlocksPerTick: number;
  private readonly provider: ethers.JsonRpcProvider | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private latestBlock: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastErrorMessage: string | null = null;

  constructor(options: MetadataIndexerOptions) {
    if (options.deployBlock < 0) throw new Error('deployBlock must be >= 0');
    if (options.tickIntervalMs <= 0) throw new Error('tickIntervalMs must be > 0');

    this.store = options.store;
    this.statsClient = options.statsClient;
    this.chainId = options.chainId;
    this.contractAddress = options.contractAddress;
    this.deployBlock = options.deployBlock;
    this.tickIntervalMs = options.tickIntervalMs;
    this.reorgSafetyBlocks = options.reorgSafetyBlocks;
    this.maxBlocksPerTick = (options.maxBlocksPerTick ?? 0) > 0
      ? options.maxBlocksPerTick!
      : DEFAULT_MAX_BLOCKS_PER_TICK;
    this.provider = options.rpcUrl ? new ethers.JsonRpcProvider(options.rpcUrl) : undefined;
  }

  start(): void {
    // tick() never throws out, but the .catch is a defensive belt-and-braces
    // for any pre-tick (`this.running` flip) crash that might bypass the
    // internal try/catch.
    void this.tick().catch(logError);
    this.timer = setInterval(() => void this.tick().catch(logError), this.tickIntervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Returns the chain head observed on the most recent tick plus the indexer's
   * reorg safety buffer. Null latestBlock means no tick has run yet (process
   * just started and the first eth_blockNumber is still in flight).
   */
  getChainHead(): ChainHead {
    return { latestBlock: this.latestBlock, reorgSafetyBlocks: this.reorgSafetyBlocks };
  }

  /**
   * Per-tick health, used by /stats to surface flaky RPC behavior. A tick that
   * runs with no thrown error counts as a success — even when the range was
   * empty or the chain was inside the reorg-safety window — because the
   * indexer itself is healthy in those cases. `lastErrorAt > lastSuccessAt`
   * (or `lastSuccessAt == null`) means the most recent tick failed.
   */
  getHealth(): IndexerHealth {
    return {
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  /**
   * One iteration end-to-end. Never throws — failures land in `getHealth`.
   *
   * Re-entrancy guard: if a prior tick is still in flight (slow RPC), the
   * next interval fire short-circuits. Without this, two concurrent ticks
   * would read the same checkpoint, fetch the same block range, and both
   * apply deltas — permanently doubling every affected agent's totals.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
      this.lastSuccessAt = Date.now();
    } catch (err) {
      this.lastErrorAt = Date.now();
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      console.error('[indexer] tick error:', err);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    const latest = await this.statsClient.getBlockNumber();
    this.latestBlock = latest;
    const safeTo = latest - this.reorgSafetyBlocks;
    if (safeTo < this.deployBlock) return;

    const checkpoint = this.store.getCheckpoint(this.chainId, this.contractAddress);
    const fromBlock = checkpoint === null ? this.deployBlock : checkpoint + 1;
    if (fromBlock > safeTo) return;

    const toBlock = Math.min(safeTo, fromBlock + this.maxBlocksPerTick - 1);
    const events = await this.statsClient.getMetadataRecordedEvents({ fromBlock, toBlock });

    // Distinct event blocks + the checkpoint block — one getBlock call covers
    // both first_seen_at stamping and the indexer's freshness reporting.
    const blocksToResolve = new Set<number>();
    for (const ev of events) blocksToResolve.add(ev.blockNumber);
    if (this.provider) blocksToResolve.add(toBlock);

    let blockTimestamps: Map<number, number> | undefined;
    let newCheckpointTimestamp: number | null = null;
    if (this.provider && blocksToResolve.size > 0) {
      const { timestamps } = await resolveBlockTimestamps(this.provider, [...blocksToResolve]);
      blockTimestamps = events.length > 0 ? timestamps : undefined;
      newCheckpointTimestamp = timestamps.get(toBlock) ?? null;
    }

    this.store.applyBatch(
      this.chainId,
      this.contractAddress,
      events,
      toBlock,
      blockTimestamps,
      newCheckpointTimestamp,
    );

    console.log(`[indexer] ${fromBlock}..${toBlock} events=${events.length}`);
  }
}

function logError(err: unknown): void {
  console.error('[indexer] error:', err);
}
