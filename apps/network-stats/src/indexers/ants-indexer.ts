/**
 * ANTS token indexer + supply sampler.
 *
 * Wraps a generic EventIndexer watching the ERC-20 `Transfer` event on the
 * configured ANTS token contract. The rollup callback feeds decoded
 * transfers into `store.applyAntsTransfers`, which keeps
 * `ants_holder_balances` + `ants_supply` in sync with on-chain state.
 *
 * A separate periodic timer samples `ants_supply` into `ants_supply_history`
 * so the supply chart populates between transfer events (a quiet token can
 * go hours without one). The sampler is a no-op when supply hasn't moved —
 * `recordAntsSupplySample` dedupes byte-identical rows.
 */

import type { ethers } from 'ethers';
import { EventIndexer, type DecodedEvent } from './event-indexer.js';
import type { SqliteStore } from '../store.js';
import type { BlockProvider } from '../utils.js';

const ANTS_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
] as const;

export interface AntsIndexerOptions {
  store: SqliteStore;
  provider: ethers.Provider & BlockProvider;
  chainId: string;
  contractAddress: string;
  deployBlock: number;
  tickIntervalMs: number;
  reorgSafetyBlocks: number;
  maxBlocksPerTick?: number;
  /**
   * How often to write a supply snapshot into `ants_supply_history`. Default
   * 1 min — matches HistorySampler's cadence so charts share a bucket
   * resolution. Snapshots are deduped against the latest stored row, so a
   * quiet token writes one row per change rather than one per minute.
   */
  supplySampleIntervalMs?: number;
}

export class AntsIndexer {
  private readonly store: SqliteStore;
  private readonly eventIndexer: EventIndexer;
  private readonly supplySampleIntervalMs: number;
  private supplyTimer: ReturnType<typeof setInterval> | undefined;

  /** Fired once per successful tick — wired by the bootstrap layer to cache invalidation. */
  onTickComplete: ((info: { eventCount: number }) => void) | null = null;
  /** Fired once per successful supply sample write. */
  onSupplySampleComplete: (() => void) | null = null;

  constructor(opts: AntsIndexerOptions) {
    this.store = opts.store;
    this.supplySampleIntervalMs = opts.supplySampleIntervalMs ?? 60_000;

    this.eventIndexer = new EventIndexer({
      store: opts.store,
      provider: opts.provider,
      chainId: opts.chainId,
      contractAddress: opts.contractAddress,
      abi: ANTS_TRANSFER_ABI as unknown as ethers.InterfaceAbi,
      eventNames: ['Transfer'],
      deployBlock: opts.deployBlock,
      tickIntervalMs: opts.tickIntervalMs,
      reorgSafetyBlocks: opts.reorgSafetyBlocks,
      ...(opts.maxBlocksPerTick !== undefined ? { maxBlocksPerTick: opts.maxBlocksPerTick } : {}),
      applyDecoded: (events) => this.applyTransfers(events),
    });

    // Re-export the underlying tick listener so the bootstrap layer can
    // wire one cache invalidation per ANTS tick.
    this.eventIndexer.onTickComplete = (info) => {
      try {
        this.onTickComplete?.(info);
      } catch (err) {
        console.error('[ants-indexer] onTickComplete listener threw:', err);
      }
    };
  }

  start(): void {
    this.eventIndexer.start();
    // Write a supply sample on the periodic schedule. The first write fires
    // immediately so a freshly-restarted process doesn't leave the chart
    // empty for one whole interval.
    this.sampleSupply();
    this.supplyTimer = setInterval(() => this.sampleSupply(), this.supplySampleIntervalMs);
  }

  stop(): void {
    this.eventIndexer.stop();
    if (this.supplyTimer !== undefined) clearInterval(this.supplyTimer);
  }

  /** Latest indexer health, for /stats/network or a future /ants/health probe. */
  getHealth() { return this.eventIndexer.getHealth(); }
  getChainHead() { return this.eventIndexer.getChainHead(); }

  /**
   * Decode the EventIndexer's raw arg-records into typed Transfer events
   * before handing them to the store. The args object's `from`/`to` are
   * already strings; `value` arrives as a stringified bigint (per
   * `argsToPlainObject`'s jsonSafe pass).
   */
  private applyTransfers(events: readonly DecodedEvent[]): void {
    const transfers = events
      .filter((ev) => ev.eventName === 'Transfer')
      .map((ev) => ({
        blockNumber: ev.blockNumber,
        from: String(ev.args['from']).toLowerCase(),
        to: String(ev.args['to']).toLowerCase(),
        value: BigInt(String(ev.args['value'])),
      }));
    this.store.applyAntsTransfers(transfers);
  }

  private sampleSupply(): void {
    try {
      const snapshot = this.store.getAntsSupply();
      // Skip cold-start writes — `lastUpdatedBlock === null` means no
      // Transfer has been applied yet, so the snapshot is structurally
      // (0, 0). Writing it would land a misleading zero point at the head
      // of the chart that the dedup can't suppress (the next real sample
      // is byte-different).
      if (snapshot.lastUpdatedBlock === null) return;
      const ts = Math.floor(Date.now() / 1000);
      const result = this.store.recordAntsSupplySample(ts, snapshot);
      if (result.written) {
        try {
          this.onSupplySampleComplete?.();
        } catch (err) {
          console.error('[ants-indexer] onSupplySampleComplete listener threw:', err);
        }
      }
    } catch (err) {
      console.error('[ants-indexer] supply sample error:', err);
    }
  }
}
