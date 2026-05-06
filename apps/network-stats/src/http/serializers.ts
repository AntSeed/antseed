import type { NetworkTotals, SellerTotals } from '../store.js';

/**
 * JSON-safe `onChainStats` shape — bigint columns flattened to strings so
 * `JSON.stringify` doesn't throw. Callers gate on
 * `(agentId !== 0 && totals !== null)`; this is the pure mapping piece.
 */
export interface OnChainStatsPayload {
  agentId: number;
  totalRequests: string;
  totalInputTokens: string;
  totalOutputTokens: string;
  settlementCount: number;
  uniqueBuyers: number;
  uniqueChannels: number;
  firstSettledBlock: number;
  lastSettledBlock: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  avgRequestsPerChannel: number;
  avgRequestsPerBuyer: number;
  lastUpdatedAt: number;
}

export function serializeOnChainStats(agentId: number, totals: SellerTotals): OnChainStatsPayload {
  return {
    agentId,
    totalRequests: totals.totalRequests.toString(),
    totalInputTokens: totals.totalInputTokens.toString(),
    totalOutputTokens: totals.totalOutputTokens.toString(),
    settlementCount: totals.settlementCount,
    uniqueBuyers: totals.uniqueBuyers,
    uniqueChannels: totals.uniqueChannels,
    firstSettledBlock: totals.firstSettledBlock,
    lastSettledBlock: totals.lastSettledBlock,
    firstSeenAt: totals.firstSeenAt,
    lastSeenAt: totals.lastSeenAt,
    avgRequestsPerChannel: totals.avgRequestsPerChannel,
    avgRequestsPerBuyer: totals.avgRequestsPerBuyer,
    lastUpdatedAt: totals.lastUpdatedAt,
  };
}

export interface NetworkTotalsPayload {
  totalRequests: string;
  totalInputTokens: string;
  totalOutputTokens: string;
  settlementCount: number;
  sellerCount: number;
  lastUpdatedAt: number | null;
}

export function serializeNetworkTotals(totals: NetworkTotals): NetworkTotalsPayload {
  return {
    totalRequests: totals.totalRequests.toString(),
    totalInputTokens: totals.totalInputTokens.toString(),
    totalOutputTokens: totals.totalOutputTokens.toString(),
    settlementCount: totals.settlementCount,
    sellerCount: totals.sellerCount,
    lastUpdatedAt: totals.lastUpdatedAt,
  };
}
