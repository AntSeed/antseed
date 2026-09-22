import type { AntsContext } from './context.js';
import type { LivePositions, RewardPositions } from './position-feed.js';

/** Live position status older than this is rejected. Antscan caches it for 15s and this client for another 15s; anything beyond a minute is a stalled feed. */
const LIVE_MAX_AGE_SECONDS = 60;
/** Antscan serves a stale snapshot while refreshing in the background; one re-read after this pause picks up the fresh one. */
const STALE_RETRY_MS = 1_500;
const REWARDS_MAX_AGE_SECONDS = 3600;
/** Tolerated clock skew between Antscan and this machine. */
const CLOCK_SKEW_SECONDS = 30;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A locally confirmed position the feed does not list yet means the feed is behind our own transactions. */
function coversLocalPositions(ctx: AntsContext, positions: Array<{ id: number }>): boolean {
  const ids = new Set(positions.map(row => row.id));
  const wallet = ctx.address.toLowerCase();
  return [...ctx.localPositionIds].every(([id, owner]) => owner.toLowerCase() !== wallet || ids.has(id));
}

/** The wallet's positions with live on-chain status from Antscan, accepted only when fresh, complete and past our read barrier. */
export async function liveWalletPositions(ctx: AntsContext, epoch: number): Promise<LivePositions> {
  const indexer = ctx.indexer();
  if (!indexer?.livePositions) throw new Error('Antscan live positions are unavailable');
  let data = await indexer.livePositions(ctx.address);
  if (data.liveSource.stale) {
    await new Promise((resolve) => setTimeout(resolve, STALE_RETRY_MS));
    data = await indexer.livePositions(ctx.address, { refresh: true });
  }
  const { liveSource } = data;
  const now = nowSeconds();
  const fresh = now - liveSource.fetchedAt < LIVE_MAX_AGE_SECONDS && liveSource.fetchedAt <= now + CLOCK_SKEW_SECONDS;
  if (data.currentEpoch !== epoch || liveSource.stale || !liveSource.complete || data.liveError || !fresh) throw new Error(data.liveError ?? 'Antscan live position status is stale or incomplete');
  const barrier = ctx.positionReadBarriers?.get(ctx.address.toLowerCase());
  if (barrier && liveSource.fetchedAt <= barrier.at) throw new Error('Antscan live positions have not caught up with your transaction');
  if (data.positions.some(row => row.power == null || row.nextPower == null || row.withdrawableEpoch === null || row.maxLockedNext === null || row.changePending === null)) throw new Error('Antscan live position fields are incomplete');
  if (!coversLocalPositions(ctx, data.positions)) throw new Error('Antscan has not indexed a locally confirmed position');
  return data;
}

/** Indexed staker rewards per position, accepted only for this chain's contracts, a fresh complete snapshot, and past our read barrier. */
export async function indexedWalletRewards(ctx: AntsContext, epoch: number, outstanding = false): Promise<RewardPositions> {
  const indexer = ctx.indexer();
  if (!indexer?.rewardPositions) throw new Error('Antscan indexed rewards are unavailable');
  const data = await indexer.rewardPositions(ctx.address, outstanding);
  const { source } = data;
  const now = nowSeconds();
  const sameChain = source.chainId === ctx.chain.evmChainId
    && source.contracts.sellerPools.toLowerCase() === ctx.chain.sellerPoolsAddress?.toLowerCase()
    && source.contracts.sellerPoolsRewards.toLowerCase() === ctx.chain.sellerPoolsRewardsAddress?.toLowerCase();
  if (!sameChain) throw new Error('Antscan reward chain or contracts do not match this dashboard');
  const fresh = now - source.indexedAt <= REWARDS_MAX_AGE_SECONDS && source.indexedAt <= now + CLOCK_SKEW_SECONDS;
  if (source.schemaVersion !== 1 || data.currentEpoch !== epoch || source.stale || !fresh) throw new Error('Antscan reward snapshot is stale');
  if (!source.complete || !source.historyComplete || source.historyFromBlock > source.indexedBlock) throw new Error('Antscan reward history is incomplete');
  const barrier = ctx.positionReadBarriers?.get(ctx.address.toLowerCase());
  if (barrier && source.indexedBlock < barrier.block) throw new Error('Antscan rewards have not caught up with your transaction');
  if (data.positions.some(row => row.rewards.status !== 'available' || row.rewards.pending === null)) throw new Error('Some indexed position rewards are unavailable');
  if (!outstanding && !coversLocalPositions(ctx, data.positions)) throw new Error('Antscan rewards have not indexed a locally confirmed position');
  return data;
}
