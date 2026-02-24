import type { UsageReceipt } from '../types/metering.js';
import type { SettlementResult } from './types.js';

export function calculateSettlement(
  sessionId: string,
  receipts: UsageReceipt[],
  platformFeeRate: number,
): SettlementResult {
  if (platformFeeRate < 0 || platformFeeRate > 1) {
    throw new Error(`platformFeeRate must be between 0 and 1, got ${platformFeeRate}`);
  }
  const matching = receipts.filter((r) => r.sessionId === sessionId);
  const totalTokens = matching.reduce((sum, r) => sum + r.tokens.totalTokens, 0);
  const totalCostUSD = matching.reduce((sum, r) => sum + r.costCents, 0) / 100;
  const platformFeeUSD = totalCostUSD * platformFeeRate;
  const sellerPayoutUSD = totalCostUSD - platformFeeUSD;

  return {
    sessionId,
    receipts: matching,
    totalTokens,
    totalCostUSD,
    platformFeeUSD,
    sellerPayoutUSD,
  };
}

export function isSettlementWithinEscrow(
  settlementCostUSD: number,
  escrowAmountUSD: number,
): boolean {
  return settlementCostUSD <= escrowAmountUSD;
}

export function calculateRefund(
  escrowAmountUSD: number,
  settlementCostUSD: number,
): number {
  return Math.max(0, escrowAmountUSD - settlementCostUSD);
}
