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
