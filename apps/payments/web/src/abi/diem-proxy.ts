import { parseAbi } from 'viem';

export const DIEM_STAKING_PROXY_ADDRESS = '0x1f228613116E2d08014DfdCC198377C8dedf18C9' as const;

/** Venice $DIEM ERC-20 token on Base (mirrors apps/diem-staking/src/lib/addresses.ts). */
export const DIEM_TOKEN_ADDRESS = '0xf4d97f2da56e8c3098f3a8d538db630a2606a024' as const;

export const DIEM_STAKING_PROXY_ABI = parseAbi([
  'function firstRewardEpoch() view returns (uint32)',
  'function finalizedRewardEpoch() view returns (uint32)',
  'function syncedRewardEpoch() view returns (uint32)',
  'function userLastClaimedEpoch(address user) view returns (uint32)',
  'function userEpochClaimed(address user, uint32 rewardEpoch) view returns (bool)',
  'function pendingAntsForEpoch(address user, uint32 rewardEpoch) view returns (uint256)',
  'function claimAnts(uint32[] rewardEpochs)',
]);
