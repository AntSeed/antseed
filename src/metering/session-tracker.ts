import { EventEmitter } from 'node:events';
import type {
  ProviderType,
  MeteringEvent,
  UsageReceipt,
  ReceiptVerification,
  SessionMetrics,
} from '../types/metering.js';

/**
 * Tracks metering events and receipts for a session,
 * computing running aggregates.
 *
 * Emits:
 * - 'event-recorded' (event: MeteringEvent)
 * - 'receipt-recorded' (receipt: UsageReceipt, verification: ReceiptVerification)
 * - 'dispute-detected' (receiptId: string, percentageDifference: number)
 * - 'session-ended' (metrics: SessionMetrics)
 */
export class SessionTracker extends EventEmitter {
  private readonly sessionId: string;
  private readonly sellerPeerId: string;
  private readonly buyerPeerId: string;
  private readonly provider: ProviderType;
  private readonly startedAt: number;
  private endedAt: number | null;

  private events: MeteringEvent[];
  private receipts: UsageReceipt[];
  private verifications: ReceiptVerification[];

  private totalTokens: number;
  private totalCostCents: number;
  private totalLatencyMs: number;
  private peerSwitches: number;
  private disputedCount: number;
  private lastPeerId: string;

  constructor(
    sessionId: string,
    sellerPeerId: string,
    buyerPeerId: string,
    provider: ProviderType
  ) {
    super();
    this.sessionId = sessionId;
    this.sellerPeerId = sellerPeerId;
    this.buyerPeerId = buyerPeerId;
    this.provider = provider;
    this.startedAt = Date.now();
    this.endedAt = null;

    this.events = [];
    this.receipts = [];
    this.verifications = [];

    this.totalTokens = 0;
    this.totalCostCents = 0;
    this.totalLatencyMs = 0;
    this.peerSwitches = 0;
    this.disputedCount = 0;
    this.lastPeerId = sellerPeerId;
  }

  /**
   * Record a metering event (one request/response cycle).
   */
  recordEvent(event: MeteringEvent): void {
    this.events.push(event);
    this.totalTokens += event.tokens.totalTokens;
    this.totalLatencyMs += event.latencyMs;
    this.emit('event-recorded', event);
  }

  /**
   * Record a receipt and its verification result.
   */
  recordReceipt(receipt: UsageReceipt, verification: ReceiptVerification): void {
    this.receipts.push(receipt);
    this.verifications.push(verification);
    this.totalCostCents += receipt.costCents;

    if (verification.disputed) {
      this.disputedCount++;
      this.emit('dispute-detected', receipt.receiptId, verification.percentageDifference);
    }

    this.emit('receipt-recorded', receipt, verification);
  }

  /**
   * Record a peer switch (failover to a different seller).
   */
  recordPeerSwitch(newPeerId: string): void {
    if (newPeerId !== this.lastPeerId) {
      this.peerSwitches++;
      this.lastPeerId = newPeerId;
    }
  }

  /**
   * End the session and return final metrics.
   */
  endSession(): SessionMetrics {
    this.endedAt = Date.now();
    const metrics = this.getMetrics();
    this.emit('session-ended', metrics);
    return metrics;
  }

  /**
   * Get current running metrics (session may still be active).
   */
  getMetrics(): SessionMetrics {
    const totalRequests = this.events.length;
    return {
      sessionId: this.sessionId,
      sellerPeerId: this.sellerPeerId,
      buyerPeerId: this.buyerPeerId,
      provider: this.provider,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      totalRequests,
      totalTokens: this.totalTokens,
      totalCostCents: this.totalCostCents,
      avgLatencyMs: totalRequests > 0 ? this.totalLatencyMs / totalRequests : 0,
      peerSwitches: this.peerSwitches,
      disputedReceipts: this.disputedCount,
    };
  }

  /**
   * Get all events in this session.
   */
  getEvents(): MeteringEvent[] {
    return [...this.events];
  }

  /**
   * Get all receipts in this session.
   */
  getReceipts(): UsageReceipt[] {
    return [...this.receipts];
  }
}
