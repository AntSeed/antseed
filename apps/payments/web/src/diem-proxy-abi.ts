export const DIEM_STAKING_PROXY_ADDRESS = '0x1f228613116E2d08014DfdCC198377C8dedf18C9' as const;

export const DIEM_STAKING_PROXY_ABI = [
  'function firstRewardEpoch() view returns (uint32)',
  'function finalizedRewardEpoch() view returns (uint32)',
  'function syncedRewardEpoch() view returns (uint32)',
  'function userLastClaimedEpoch(address user) view returns (uint32)',
  'function userEpochClaimed(address user, uint32 rewardEpoch) view returns (bool)',
  'function pendingAntsForEpoch(address user, uint32 rewardEpoch) view returns (uint256)',
  'function claimAnts(uint32[] rewardEpochs)',
] as const;
