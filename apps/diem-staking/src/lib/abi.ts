// Minimal ABIs for the on-chain reads/writes this app performs. Using viem's
// `parseAbi` keeps them legible and well-typed via wagmi's codegen-free hooks.
//
// IMPORTANT: these must stay in lockstep with the on-chain DiemStakingProxy.
// The source of truth is `packages/contracts/DiemStakingProxy.sol`. When a
// signature there changes, mirror it here.

import { parseAbi } from 'viem';

/**
 * DiemStakingProxy — subset of the full contract ABI used by this portal.
 *
 * Reads:
 *   - totalStaked / staked(user) / stakerCount — TVL + distinct-staker tile
 *   - totalUsdcDistributedEver — lifetime USDC tile
 *   - maxTotalStake — cap display + stake-disabled guard
 *   - earnedUsdc(user) — claimable USDC
 *   - firstRewardEpoch / syncedRewardEpoch / finalizedRewardEpoch /
 *     userLastClaimedEpoch(user) / userEpochClaimed(user, epoch) /
 *     pendingAntsForEpoch(user, epoch) — per-epoch ANTS preview, summed
 *     across the user's synced range
 *   - currentUnstakeBatch / oldestUnclaimedUnstakeBatch / unstakeBatches(id) /
 *     unstakeBatchUserAmount(id, user) — unstake queue state machine
 *   - minUnstakeBatchOpenSecs / currentUnstakeBatchOpenedAt / flushableAt — minimum
 *     batch-open window gate (so a first queuer can't immediately flush)
 *
 * Writes:
 *   - stake, initiateUnstake, flush, claimUnstakeBatch, claimUsdc, claimAnts,
 *     syncRewardEpochs
 */
export const DIEM_STAKING_PROXY_ABI = parseAbi([
  // Reads — staking
  'function totalStaked() view returns (uint256)',
  'function staked(address user) view returns (uint256)',
  'function stakerCount() view returns (uint32)',
  'function maxTotalStake() view returns (uint256)',

  // Reads — USDC rewards
  'function earnedUsdc(address user) view returns (uint256)',
  'function totalUsdcDistributedEver() view returns (uint256)',

  // Reads — ANTS rewards
  'function firstRewardEpoch() view returns (uint32)',
  'function syncedRewardEpoch() view returns (uint32)',
  'function finalizedRewardEpoch() view returns (uint32)',
  'function userLastClaimedEpoch(address user) view returns (uint32)',
  'function userEpochClaimed(address user, uint32 rewardEpoch) view returns (bool)',
  'function pendingAntsForEpoch(address user, uint32 rewardEpoch) view returns (uint256)',

  // Reads — unstake queue
  'function currentUnstakeBatch() view returns (uint32)',
  'function oldestUnclaimedUnstakeBatch() view returns (uint32)',
  'function unstakeBatches(uint32 id) view returns (uint128 total, uint64 unlockAt, uint32 userCount, bool claimed)',
  'function unstakeBatchUserAmount(uint32 id, address user) view returns (uint128)',

  // Reads — minimum batch-open window
  'function minUnstakeBatchOpenSecs() view returns (uint64)',
  'function currentUnstakeBatchOpenedAt() view returns (uint64)',
  'function flushableAt() view returns (uint64)',

  // Writes — staker actions
  'function stake(uint256 amount)',
  'function initiateUnstake(uint256 amount)',
  'function flush()',
  'function claimUnstakeBatch(uint32 batchId)',
  'function claimUsdc()',
  'function claimAnts(uint32[] rewardEpochs)',
  'function syncRewardEpochs(uint32 maxEpochs)',

  // Events — for "USDC distributed per completed reward epoch" aggregation.
  // Aggregated in-browser via getLogs over a bounded window; see hooks.ts.
  'event UsdcDistributed(uint256 amount)',
  'event RewardEpochClosed(uint32 indexed rewardEpochId, uint256 revenuePerTokenAtEnd, uint256 totalPoints)',
  'event RewardEpochFunded(uint32 indexed rewardEpochId, uint256 antsPot)',
]);

/**
 * DIEM token ABI — ERC-20 basics plus the three Venice-specific methods the
 * proxy depends on. Cooldown is read live for the UI's unstake copy.
 */
export const DIEM_TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function cooldownDuration() view returns (uint256)',
]);
