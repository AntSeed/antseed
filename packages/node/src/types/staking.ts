import type { PeerId } from './peer.js';

export type StakeStatus = 'active' | 'slashed' | 'withdrawn';

export interface StakeInfo {
  peerId: PeerId;
  amountUSDC: number;
  stakedAt: number;
  lockPeriodDays: number;
  status: StakeStatus;
}

export interface StakeConfig {
  minStakeUSDC: number;
  lockPeriodDays: number;
  slashPercentage: number;
}

export const DEFAULT_STAKE_CONFIG: StakeConfig = {
  minStakeUSDC: 100,
  lockPeriodDays: 30,
  slashPercentage: 10,
};

/** On-chain proven stats for a seller, derived from escrow ReputationData. */
export interface ProvenSellerStats {
  totalTransactions: number;
  totalVolumeUsdc: bigint;
  uniqueBuyersServed: number;
  stakedAmount: bigint;
  totalSlashed: bigint;
  slashCount: number;
  antsEarned: bigint;
  ageDays: number;
  avgRating: number;
  ratingCount: number;
}

/** On-chain proven stats for a buyer, derived from escrow BuyerAccount. */
export interface ProvenBuyerStats {
  firstTransactionAt: number;
  uniqueSellersCount: number;
}

/** Slash record for dispute resolution tracking. */
export interface SlashRecord {
  seller: string;
  buyer: string;
  sessionId: string;
  amount: bigint;
  reason: string;
  timestamp: number;
  txHash: string;
}
