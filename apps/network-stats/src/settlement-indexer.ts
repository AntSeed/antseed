import { ethers } from 'ethers';
import type { ChannelsClient, StatsClient, StakingClient, DecodedMetadataRecorded } from '@antseed/node';
import type { SqliteStore } from './store.js';

export interface SettlementIndexerOptions {
  store: SqliteStore;
  channelsClient: Pick<ChannelsClient, 'getChannelSettledEvents' | 'getBlockNumber'>;
  statsClient: Pick<StatsClient, 'getMetadataRecordedEvents'>;
  stakingClient: Pick<StakingClient, 'getAgentId'>;
  chainId: string;
  contractAddress: string;     // channels contract, lowercased
  deployBlock: number;
  tickIntervalMs: number;
  reorgSafetyBlocks: number;
  maxBlocksPerTick?: number;
  rpcUrl: string;              // required — block timestamps are mandatory for leaderboard
}

function logError(err: unknown): void {
  console.error('[settlement-indexer] error:', err);
}

export class SettlementIndexer {
  private readonly _store: SqliteStore;
  private readonly _channelsClient: Pick<ChannelsClient, 'getChannelSettledEvents' | 'getBlockNumber'>;
  private readonly _statsClient: Pick<StatsClient, 'getMetadataRecordedEvents'>;
  private readonly _stakingClient: Pick<StakingClient, 'getAgentId'>;
  private readonly _chainId: string;
  private readonly _contractAddress: string;
  private readonly _deployBlock: number;
  private readonly _tickIntervalMs: number;
  private readonly _reorgSafetyBlocks: number;
  private readonly _maxBlocksPerTick: number;
  private readonly _provider: ethers.JsonRpcProvider;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _running = false;
  private _latestBlock: number | null = null;

  // Cache seller address → agentId. Staked sellers don't change agentId,
  // so cache indefinitely. Unstaked (agentId=0) cached for 5 min.
  private readonly _agentIdCache = new Map<string, { agentId: number; expiresAt: number }>();
  private static readonly UNSTAKED_TTL_MS = 5 * 60 * 1000;

  constructor(options: SettlementIndexerOptions) {
    if (options.deployBlock < 0) {
      throw new Error('deployBlock must be >= 0');
    }
    if (options.tickIntervalMs <= 0) {
      throw new Error('tickIntervalMs must be > 0');
    }

    this._store = options.store;
    this._channelsClient = options.channelsClient;
    this._statsClient = options.statsClient;
    this._stakingClient = options.stakingClient;
    this._chainId = options.chainId;
    this._contractAddress = options.contractAddress;
    this._deployBlock = options.deployBlock;
    this._tickIntervalMs = options.tickIntervalMs;
    this._reorgSafetyBlocks = options.reorgSafetyBlocks;

    const provided = options.maxBlocksPerTick;
    this._maxBlocksPerTick = (provided !== undefined && provided > 0) ? provided : 2_000;
    this._provider = new ethers.JsonRpcProvider(options.rpcUrl);
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

  async tick(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const latest = await this._channelsClient.getBlockNumber();
      this._latestBlock = latest;
      const safeTo = latest - this._reorgSafetyBlocks;

      if (safeTo < this._deployBlock) return;

      const checkpoint = this._store.getCheckpoint(this._chainId, this._contractAddress);
      const fromBlock = checkpoint === null ? this._deployBlock : checkpoint + 1;

      if (fromBlock > safeTo) return;

      const toBlock = Math.min(safeTo, fromBlock + this._maxBlocksPerTick - 1);

      // 1. Fetch ChannelSettled events
      const events = await this._channelsClient.getChannelSettledEvents({ fromBlock, toBlock });

      if (events.length === 0) {
        // No events — just advance the checkpoint
        let checkpointTs: number | null = null;
        const block = await this._provider.getBlock(toBlock);
        checkpointTs = block?.timestamp ?? null;
        this._store.applySettlementBatch(
          this._chainId,
          this._contractAddress,
          [],
          new Map(),
          new Map(),
          toBlock,
          new Map(),
          checkpointTs,
        );
        console.log(`[settlement-indexer] ${fromBlock}..${toBlock} events=0`);
        return;
      }

      // 2. Fetch block timestamps for all event blocks
      const uniqueBlocks = Array.from(new Set(events.map((e) => e.blockNumber)));
      const blocks = await Promise.all(uniqueBlocks.map((b) => this._provider.getBlock(b)));
      const blockTimestamps = new Map<number, number>();
      for (let i = 0; i < uniqueBlocks.length; i++) {
        const block = blocks[i];
        if (block) blockTimestamps.set(uniqueBlocks[i]!, block.timestamp);
      }

      // Checkpoint timestamp
      let checkpointTs: number | null = null;
      if (blockTimestamps.has(toBlock)) {
        checkpointTs = blockTimestamps.get(toBlock)!;
      } else {
        const block = await this._provider.getBlock(toBlock);
        checkpointTs = block?.timestamp ?? null;
      }

      // 3. Fetch MetadataRecorded events from the same block range (for token counts)
      const metadataEvents = await this._statsClient.getMetadataRecordedEvents({ fromBlock, toBlock });
      const metadataByTx = new Map<string, DecodedMetadataRecorded[]>();
      for (const m of metadataEvents) {
        const existing = metadataByTx.get(m.txHash);
        if (existing) {
          existing.push(m);
        } else {
          metadataByTx.set(m.txHash, [m]);
        }
      }

      // 4. Resolve seller addresses → agentIds
      const uniqueSellers = Array.from(new Set(events.map((e) => e.seller)));
      const agentIdBySeller = new Map<string, number>();
      await Promise.all(
        uniqueSellers.map(async (seller) => {
          const agentId = await this._resolveAgentId(seller);
          agentIdBySeller.set(seller, agentId);
        }),
      );

      // 5. Store
      this._store.applySettlementBatch(
        this._chainId,
        this._contractAddress,
        events,
        metadataByTx,
        agentIdBySeller,
        toBlock,
        blockTimestamps,
        checkpointTs,
      );

      console.log(`[settlement-indexer] ${fromBlock}..${toBlock} events=${events.length}`);
    } catch (err) {
      console.error('[settlement-indexer] tick error:', err);
    } finally {
      this._running = false;
    }
  }

  private async _resolveAgentId(seller: string): Promise<number> {
    const key = seller.toLowerCase();
    const cached = this._agentIdCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.agentId;
    }
    try {
      const agentId = await this._stakingClient.getAgentId(key);
      this._agentIdCache.set(key, {
        agentId,
        expiresAt: agentId === 0 ? Date.now() + SettlementIndexer.UNSTAKED_TTL_MS : Infinity,
      });
      return agentId;
    } catch (err) {
      console.warn(`[settlement-indexer] getAgentId failed for ${key}:`, err);
      return 0;
    }
  }
}
