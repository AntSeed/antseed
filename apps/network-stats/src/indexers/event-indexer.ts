/**
 * Generic, contract-agnostic event indexer. Watches a contract address for a
 * configured set of events, decodes each log via the supplied ABI fragment,
 * persists raw rows into `chain_events`, and lets the consumer attach a
 * rollup callback that runs in the same DB transaction.
 *
 * The existing `MetadataIndexer` predates this and keeps its own loop —
 * intentional: that one uses the high-level StatsClient (already battle-
 * tested + extensively unit-tested via mock client). EventIndexer is for
 * new contracts (ANTS, ReputationRegistry, …) where there's no purpose-built
 * client and the loop only needs ABI + topic filtering.
 *
 * Tick contract:
 *   1. Fetch logs for [fromBlock, toBlock], where toBlock = head − reorg
 *      buffer and fromBlock advances from the persisted checkpoint.
 *   2. Decode each log. Bigint args are stringified before they reach the DB
 *      so JSON.stringify can serialize them.
 *   3. Resolve block timestamps for distinct event blocks + the new
 *      checkpoint block (the latter so /events can show wall-clock time on
 *      "no events this tick" rows too).
 *   4. Inside one DB transaction: run the consumer's `applyDecoded`, insert
 *      every chain_events row, advance the indexer_checkpoint. A throw at
 *      any step rolls back the whole tx — next tick re-fetches the same
 *      range.
 *   5. Fire `onTickComplete` so the bootstrap layer can invalidate caches.
 *
 * Re-entrancy guard mirrors MetadataIndexer's: a slow RPC must not let two
 * ticks read the same checkpoint and double-apply rollups.
 */

import { ethers } from 'ethers';
import type { ChainEventInsert, SqliteStore } from '../store.js';
import { resolveBlockTimestamps, type BlockProvider } from '../utils.js';

export interface DecodedEvent {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  eventName: string;
  /**
   * Decoded event inputs keyed by ABI input name. Bigint values are
   * pre-stringified — matches the on-disk shape so consumers don't need to
   * convert again before persisting derived state.
   */
  args: Record<string, unknown>;
}

export interface EventIndexerOptions {
  store: SqliteStore;
  /**
   * Provider used for both `getLogs` and `getBlock` calls. A
   * FallbackProvider is fine — the same instance is reused across ticks
   * and benefits from any failover the caller has wired up.
   */
  provider: ethers.Provider & BlockProvider;
  chainId: string;
  contractAddress: string;     // any case; lowercased internally for storage
  abi: ethers.InterfaceAbi;    // full ABI fragment (or just the events we care about)
  /** Names of events from the ABI to subscribe to. Each becomes a topic0 filter. */
  eventNames: string[];
  /** Block where the contract was deployed; the floor for cold-start scans. */
  deployBlock: number;
  tickIntervalMs: number;
  reorgSafetyBlocks: number;
  maxBlocksPerTick?: number;
  /**
   * Optional consumer rollup. Called inside the tick's DB transaction with
   * the decoded events for this tick + a Map of block → unix-second
   * timestamps for those blocks. The callback can write through the same
   * `store` instance — its writes commit/roll back atomically with the
   * chain_events insert.
   */
  applyDecoded?: (events: DecodedEvent[], blockTimestamps: Map<number, number>) => void;
}

const DEFAULT_MAX_BLOCKS_PER_TICK = 2_000;

export interface EventIndexerHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
}

export interface EventIndexerHead {
  latestBlock: number | null;
  reorgSafetyBlocks: number;
}

export class EventIndexer {
  private readonly store: SqliteStore;
  private readonly provider: ethers.Provider & BlockProvider;
  private readonly chainId: string;
  private readonly contractAddress: string;
  private readonly iface: ethers.Interface;
  private readonly topicFilter: string[];
  private readonly deployBlock: number;
  private readonly tickIntervalMs: number;
  private readonly reorgSafetyBlocks: number;
  private readonly maxBlocksPerTick: number;
  private readonly applyDecoded: EventIndexerOptions['applyDecoded'];
  private readonly logPrefix: string;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private latestBlock: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastErrorMessage: string | null = null;

  /** Fired after every successful tick so the cache layer can invalidate. */
  onTickComplete: ((info: { eventCount: number }) => void) | null = null;

  constructor(options: EventIndexerOptions) {
    if (options.deployBlock < 0) throw new Error('deployBlock must be >= 0');
    if (options.tickIntervalMs <= 0) throw new Error('tickIntervalMs must be > 0');
    if (options.eventNames.length === 0) throw new Error('eventNames must not be empty');

    this.store = options.store;
    this.provider = options.provider;
    this.chainId = options.chainId;
    this.contractAddress = options.contractAddress.toLowerCase();
    this.iface = new ethers.Interface(options.abi);
    this.topicFilter = options.eventNames.map((name) => {
      const fragment = this.iface.getEvent(name);
      if (!fragment) throw new Error(`event ${name} not found in supplied ABI`);
      return fragment.topicHash;
    });
    this.deployBlock = options.deployBlock;
    this.tickIntervalMs = options.tickIntervalMs;
    this.reorgSafetyBlocks = options.reorgSafetyBlocks;
    this.maxBlocksPerTick = (options.maxBlocksPerTick ?? 0) > 0
      ? options.maxBlocksPerTick!
      : DEFAULT_MAX_BLOCKS_PER_TICK;
    this.applyDecoded = options.applyDecoded;
    // Compact identifier in the form `event-indexer:<contract6>` — short
    // enough to scan in a tight log column, unique enough across multiple
    // contracts to know who's emitting what.
    this.logPrefix = `[event-indexer:${this.contractAddress.slice(0, 8)}]`;
  }

  start(): void {
    void this.tick().catch((err) => console.error(this.logPrefix, 'error:', err));
    this.timer = setInterval(
      () => void this.tick().catch((err) => console.error(this.logPrefix, 'error:', err)),
      this.tickIntervalMs,
    );
  }

  stop(): void {
    clearInterval(this.timer);
  }

  getChainHead(): EventIndexerHead {
    return { latestBlock: this.latestBlock, reorgSafetyBlocks: this.reorgSafetyBlocks };
  }

  getHealth(): EventIndexerHealth {
    return {
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  /** One tick end-to-end. Never throws; failures land in `getHealth`. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const eventCount = await this.runOnce();
      this.lastSuccessAt = Date.now();
      try {
        this.onTickComplete?.({ eventCount });
      } catch (err) {
        console.error(this.logPrefix, 'onTickComplete listener threw:', err);
      }
    } catch (err) {
      this.lastErrorAt = Date.now();
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      console.error(this.logPrefix, 'tick error:', err);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<number> {
    const latest = Number(await this.provider.getBlockNumber());
    this.latestBlock = latest;
    const safeTo = latest - this.reorgSafetyBlocks;
    if (safeTo < this.deployBlock) return 0;

    const checkpoint = this.store.getCheckpoint(this.chainId, this.contractAddress);
    const fromBlock = checkpoint === null ? this.deployBlock : checkpoint + 1;
    if (fromBlock > safeTo) return 0;

    const toBlock = Math.min(safeTo, fromBlock + this.maxBlocksPerTick - 1);

    const logs = await this.provider.getLogs({
      address: this.contractAddress,
      fromBlock,
      toBlock,
      // OR-of-topics: ethers accepts an array as the topic0 slot to mean any-of.
      topics: [this.topicFilter],
    });

    // Decode + sort. Ethers returns logs in arrival order from the RPC, which
    // is mostly already sorted but not guaranteed across providers. Sorting
    // here means downstream rollups can assume monotonic iteration.
    const decoded: DecodedEvent[] = [];
    for (const log of logs) {
      const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      decoded.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        eventName: parsed.name,
        args: argsToPlainObject(parsed),
      });
    }
    decoded.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );

    // Distinct event blocks + the checkpoint block. The checkpoint block's
    // timestamp is what /stats reports as `lastBlockTimestamp`, so we resolve
    // it even on empty ticks so the indexer doesn't appear "frozen" to the UI.
    const blocksToResolve = new Set<number>();
    for (const ev of decoded) blocksToResolve.add(ev.blockNumber);
    blocksToResolve.add(toBlock);
    const { timestamps } = await resolveBlockTimestamps(this.provider, [...blocksToResolve]);
    const newCheckpointTimestamp = timestamps.get(toBlock) ?? null;

    const rows: ChainEventInsert[] = decoded.map((ev) => ({
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      blockNumber: ev.blockNumber,
      blockTimestamp: timestamps.get(ev.blockNumber) ?? null,
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      eventName: ev.eventName,
      args: ev.args,
    }));

    this.store.applyChainEventBatch({
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      rows,
      newCheckpoint: toBlock,
      newCheckpointTimestamp,
      ...(this.applyDecoded ? { apply: () => this.applyDecoded!(decoded, timestamps) } : {}),
    });

    console.log(`${this.logPrefix} ${fromBlock}..${toBlock} events=${decoded.length}`);
    return decoded.length;
  }
}

/**
 * Convert ethers `LogDescription.args` (Result) into a plain object keyed by
 * the ABI input names, with bigints stringified for JSON-safety. We emit
 * named keys — not positional indices — because consumers and the
 * chain_events read path both want a stable shape that survives ABI
 * reordering between deploys.
 */
export function argsToPlainObject(parsed: ethers.LogDescription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const inputs = parsed.fragment.inputs;
  for (let i = 0; i < inputs.length; i++) {
    const name = inputs[i]?.name || `arg${i}`;
    out[name] = jsonSafe(parsed.args[i]);
  }
  return out;
}

/**
 * Recursive bigint → string conversion. Touches arrays and plain objects but
 * leaves strings/numbers/booleans/null alone. Anything we can't classify is
 * stringified defensively rather than left as-is, so an unexpected ethers
 * return type can never blow up `JSON.stringify` at write time.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  return String(value);
}
