/**
 * ERC-8004 ReputationRegistry indexer.
 *
 * Watches three events on the configured ReputationRegistry proxy:
 *   - NewFeedback        → buyer submits feedback for an agent
 *   - ResponseAppended   → seller (or anyone authorized) responds inline
 *   - FeedbackRevoked    → buyer revokes a previous feedback
 *
 * Each tick decodes raw logs via the EventIndexer, translates them into
 * typed `ReputationEvent` records, and feeds them through
 * `store.applyReputationEvents` — which runs inside the same DB transaction
 * as the chain_events insert + checkpoint advance, so a partial apply can
 * never land.
 *
 * Note on `tag1`: ERC-8004 indexes a *hashed* version of tag1 (Solidity
 * indexes strings as keccak256 of the bytes). The non-indexed `tag1`
 * parameter carries the raw string we surface in the API. We ignore the
 * `indexedTag1` parameter — it's a hash, not human-readable, and we already
 * store the raw value.
 */

import type { ethers } from 'ethers';
import { EventIndexer, type DecodedEvent } from './event-indexer.js';
import type { ReputationEvent, SqliteStore } from '../store.js';
import type { BlockProvider } from '../utils.js';

const REPUTATION_ABI = [
  // Match the verified ABI on BaseScan exactly. tag1 is indexed once (as a
  // hashed string) and again as a raw non-indexed string — the proxy ABI
  // names the hash slot `indexedTag1` to disambiguate.
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)',
  'event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)',
] as const;

export interface ReputationIndexerOptions {
  store: SqliteStore;
  provider: ethers.Provider & BlockProvider;
  chainId: string;
  contractAddress: string;
  deployBlock: number;
  tickIntervalMs: number;
  reorgSafetyBlocks: number;
  maxBlocksPerTick?: number;
}

export class ReputationIndexer {
  private readonly store: SqliteStore;
  private readonly eventIndexer: EventIndexer;

  /** Fired after every successful tick. Wired by the bootstrap layer. */
  onTickComplete: ((info: { eventCount: number }) => void) | null = null;

  constructor(opts: ReputationIndexerOptions) {
    this.store = opts.store;
    this.eventIndexer = new EventIndexer({
      store: opts.store,
      provider: opts.provider,
      chainId: opts.chainId,
      contractAddress: opts.contractAddress,
      abi: REPUTATION_ABI as unknown as ethers.InterfaceAbi,
      eventNames: ['NewFeedback', 'ResponseAppended', 'FeedbackRevoked'],
      deployBlock: opts.deployBlock,
      tickIntervalMs: opts.tickIntervalMs,
      reorgSafetyBlocks: opts.reorgSafetyBlocks,
      ...(opts.maxBlocksPerTick !== undefined ? { maxBlocksPerTick: opts.maxBlocksPerTick } : {}),
      applyDecoded: (events, blockTimestamps) => this.apply(events, blockTimestamps),
    });
    this.eventIndexer.onTickComplete = (info) => {
      try {
        this.onTickComplete?.(info);
      } catch (err) {
        console.error('[reputation-indexer] onTickComplete listener threw:', err);
      }
    };
  }

  start(): void { this.eventIndexer.start(); }
  stop(): void { this.eventIndexer.stop(); }
  getHealth() { return this.eventIndexer.getHealth(); }
  getChainHead() { return this.eventIndexer.getChainHead(); }

  private apply(events: readonly DecodedEvent[], blockTimestamps: Map<number, number>): void {
    const translated: ReputationEvent[] = [];
    for (const ev of events) {
      switch (ev.eventName) {
        case 'NewFeedback':
          translated.push({
            kind: 'NewFeedback',
            blockNumber: ev.blockNumber,
            blockTimestamp: blockTimestamps.get(ev.blockNumber) ?? null,
            txHash: ev.txHash,
            agentId: BigInt(String(ev.args['agentId'])),
            clientAddress: String(ev.args['clientAddress']),
            feedbackIndex: Number(ev.args['feedbackIndex']),
            value: BigInt(String(ev.args['value'])),
            valueDecimals: Number(ev.args['valueDecimals']),
            tag1: String(ev.args['tag1'] ?? ''),
            tag2: String(ev.args['tag2'] ?? ''),
            endpoint: String(ev.args['endpoint'] ?? ''),
            feedbackURI: String(ev.args['feedbackURI'] ?? ''),
            feedbackHash: String(ev.args['feedbackHash'] ?? ''),
          });
          break;
        case 'ResponseAppended':
          translated.push({
            kind: 'ResponseAppended',
            blockNumber: ev.blockNumber,
            agentId: BigInt(String(ev.args['agentId'])),
            clientAddress: String(ev.args['clientAddress']),
            feedbackIndex: Number(ev.args['feedbackIndex']),
            responder: String(ev.args['responder']),
            responseURI: String(ev.args['responseURI'] ?? ''),
            responseHash: String(ev.args['responseHash'] ?? ''),
          });
          break;
        case 'FeedbackRevoked':
          translated.push({
            kind: 'FeedbackRevoked',
            blockNumber: ev.blockNumber,
            agentId: BigInt(String(ev.args['agentId'])),
            clientAddress: String(ev.args['clientAddress']),
            feedbackIndex: Number(ev.args['feedbackIndex']),
          });
          break;
      }
    }
    this.store.applyReputationEvents(translated);
  }
}
