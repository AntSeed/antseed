import { randomUUID } from 'node:crypto';
import type { PeerId } from '../types/peer.js';
import type { UsageReceipt } from '../types/metering.js';
import type { PaymentDispute } from './types.js';

export const DISPUTE_TIMEOUT_MS = 72 * 60 * 60 * 1000;

export function createDispute(
  channel: { channelId: string; sessionId: string },
  initiatorPeerId: PeerId,
  reason: string,
  buyerReceipts: UsageReceipt[],
  sellerReceipts: UsageReceipt[],
): PaymentDispute {
  return {
    disputeId: randomUUID(),
    channelId: channel.channelId,
    sessionId: channel.sessionId,
    initiatorPeerId,
    reason,
    status: 'open',
    buyerReceipts,
    sellerReceipts,
    createdAt: Date.now(),
    resolvedAt: null,
    resolution: null,
  };
}

export function detectDiscrepancy(
  buyerReceipts: UsageReceipt[],
  sellerReceipts: UsageReceipt[],
  thresholdPercent: number,
): { discrepancyDetected: boolean; buyerTotal: number; sellerTotal: number; diffPercent: number } {
  const buyerTotal = buyerReceipts.reduce((sum, r) => sum + r.tokens.totalTokens, 0);
  const sellerTotal = sellerReceipts.reduce((sum, r) => sum + r.tokens.totalTokens, 0);
  const max = Math.max(buyerTotal, sellerTotal);
  const diffPercent = max === 0 ? 0 : (Math.abs(buyerTotal - sellerTotal) / max) * 100;
  const discrepancyDetected = diffPercent > thresholdPercent;

  return {
    discrepancyDetected,
    buyerTotal,
    sellerTotal,
    diffPercent,
  };
}

export function resolveDispute(
  dispute: PaymentDispute,
  resolution: string,
): PaymentDispute {
  return {
    ...dispute,
    status: 'resolved',
    resolvedAt: Date.now(),
    resolution,
  };
}

export function isDisputeExpired(dispute: PaymentDispute): boolean {
  return Date.now() - dispute.createdAt > DISPUTE_TIMEOUT_MS;
}

export function calculateDisputedAmount(
  buyerReceipts: UsageReceipt[],
  sellerReceipts: UsageReceipt[],
): number {
  const buyerTotalUsd = buyerReceipts.reduce((sum, r) => sum + r.costCents, 0) / 100;
  const sellerTotalUsd = sellerReceipts.reduce((sum, r) => sum + r.costCents, 0) / 100;
  return Math.abs(buyerTotalUsd - sellerTotalUsd);
}
