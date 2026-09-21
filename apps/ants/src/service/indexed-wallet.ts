import type { AntsContext } from './context.js';
import type { LivePositions, RewardPositions } from './position-feed.js';

export async function liveWalletPositions(ctx: AntsContext, epoch: number): Promise<LivePositions> {
  const indexer = ctx.indexer();
  if (!indexer?.livePositions) throw new Error('Antscan live positions are unavailable');
  const data = await indexer.livePositions(ctx.address);
  const now = Math.floor(Date.now() / 1000);
  const barrier = ctx.positionReadBarriers?.get(ctx.address.toLowerCase());
  if (data.currentEpoch !== epoch || data.liveSource.stale || !data.liveSource.complete || data.liveError || now - data.liveSource.fetchedAt >= 15 || data.liveSource.fetchedAt > now + 30) throw new Error(data.liveError ?? 'Antscan live position status is stale or incomplete');
  if (barrier && data.liveSource.fetchedAt <= barrier.at) throw new Error('Antscan live positions have not caught up with your transaction');
  if (data.positions.some(row => row.power == null || row.nextPower == null || row.withdrawableEpoch === null || row.maxLockedNext === null || row.changePending === null)) throw new Error('Antscan live position fields are incomplete');
  const ids = new Set(data.positions.map(row => row.id));
  if ([...ctx.localPositionIds].some(([id, owner]) => owner.toLowerCase() === ctx.address.toLowerCase() && !ids.has(id))) throw new Error('Antscan has not indexed a locally confirmed position');
  return data;
}

export async function indexedWalletRewards(ctx: AntsContext, epoch: number, outstanding = false): Promise<RewardPositions> {
  const indexer = ctx.indexer();
  if (!indexer?.rewardPositions) throw new Error('Antscan indexed rewards are unavailable');
  const data = await indexer.rewardPositions(ctx.address, outstanding);
  const source = data.source;
  const now = Math.floor(Date.now() / 1000);
  const barrier = ctx.positionReadBarriers?.get(ctx.address.toLowerCase());
  if (source.chainId !== ctx.chain.evmChainId || source.contracts.sellerPools.toLowerCase() !== ctx.chain.sellerPoolsAddress?.toLowerCase() || source.contracts.sellerPoolsRewards.toLowerCase() !== ctx.chain.sellerPoolsRewardsAddress?.toLowerCase()) throw new Error('Antscan reward chain or contracts do not match this dashboard');
  if (source.schemaVersion !== 1 || data.currentEpoch !== epoch || source.stale || now - source.indexedAt > 3600 || source.indexedAt > now + 30) throw new Error('Antscan reward snapshot is stale');
  if (!source.complete || !source.historyComplete || source.historyFromBlock > source.indexedBlock) throw new Error('Antscan reward history is incomplete');
  if (barrier && source.indexedBlock < barrier.block) throw new Error('Antscan rewards have not caught up with your transaction');
  if (data.positions.some(row => row.rewards.status !== 'available' || row.rewards.pending === null)) throw new Error('Some indexed position rewards are unavailable');
  if (!outstanding) {
    const ids = new Set(data.positions.map(row => row.id));
    if ([...ctx.localPositionIds].some(([id, owner]) => owner.toLowerCase() === ctx.address.toLowerCase() && !ids.has(id))) throw new Error('Antscan rewards have not indexed a locally confirmed position');
  }
  return data;
}
