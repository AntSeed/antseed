import type { CliSellerPoolsClient as SellerPoolsClient, CliSellerPoolsRewardsClient as SellerPoolsRewardsClient } from '../seller-contract-clients.js';

export type RewardTransactionRecorder = (hash: string, kind: 'claim' | 'accounting') => Promise<void>;

export async function pendingEpochRewards(
  epochs: number[],
  readPending: (epochs: number[]) => Promise<bigint>,
): Promise<bigint> {
  let amount = 0n;
  for (let offset = 0; offset < epochs.length; offset += 32) {
    amount += await readPending(epochs.slice(offset, offset + 32));
  }
  return amount;
}

export async function claimEpochRewards(
  epochs: number[],
  readPending: (epochs: number[]) => Promise<bigint>,
  claim: (epochs: number[]) => Promise<string>,
  record: RewardTransactionRecorder,
): Promise<void> {
  for (let offset = 0; offset < epochs.length; offset += 32) {
    const batch = epochs.slice(offset, offset + 32);
    if (await readPending(batch) > 0n) await record(await claim(batch), 'claim');
  }
}

export async function claimBuyerEpochRewards(
  epochs: number[],
  readPending: (epoch: number) => Promise<bigint>,
  claim: (epoch: number) => Promise<string>,
  record: RewardTransactionRecorder,
): Promise<void> {
  for (const epoch of epochs) {
    if (await readPending(epoch) > 0n) await record(await claim(epoch), 'claim');
  }
}

type PoolReader = Pick<SellerPoolsClient, 'rewardPositions' | 'position' | 'currentEpoch'>;
type PoolRewards = Pick<SellerPoolsRewardsClient,
  'previewStakerReward' | 'pendingIndexedStakerReward' | 'poolRewardIndexNextEpoch' |
  'initialIndexEpoch' | 'indexPoolRewards' | 'claimStakerRewardsBatch'>;
type RewardSigner = Parameters<SellerPoolsRewardsClient['claimStakerRewardsBatch']>[0];

export async function previewPoolRewards(pools: PoolReader, rewards: PoolRewards, address: string, positionId?: number) {
  const positions = positionId === undefined ? await pools.rewardPositions(address) : [await pools.position(positionId)];
  const pending: Array<{ id: number; agentId: number; amount: bigint; closedAtEpoch: number }> = [];
  for (const position of positions) {
    if (position.owner.toLowerCase() !== address.toLowerCase()) throw new Error(`Position ${position.id} is not owned by this wallet.`);
    pending.push({ id: position.id, agentId: position.agentId, amount: await rewards.previewStakerReward(position.id), closedAtEpoch: position.closedAtEpoch });
  }
  return pending;
}

export async function claimPoolRewards(
  pools: PoolReader,
  rewards: PoolRewards,
  wallet: RewardSigner,
  address: string,
  recipient: string,
  record: RewardTransactionRecorder,
  preparing: () => void,
  positionId?: number,
): Promise<void> {
  const pending = await previewPoolRewards(pools, rewards, address, positionId);
  const rewardedPositions = pending.filter((position) => position.amount > 0n);
  if (rewardedPositions.length === 0) return;
  const currentEpoch = await pools.currentEpoch();
  for (const agentId of new Set(rewardedPositions.map((position) => position.agentId))) {
    const targetEpoch = rewardedPositions.filter((position) => position.agentId === agentId)
      .reduce((latest, position) => Math.max(latest, Math.min(currentEpoch, position.closedAtEpoch || currentEpoch)), 0);
    let cursor = await rewards.poolRewardIndexNextEpoch(agentId) || await rewards.initialIndexEpoch();
    if (cursor < targetEpoch) preparing();
    while (cursor < targetEpoch) {
      await record(await rewards.indexPoolRewards(wallet, agentId, Math.min(16, targetEpoch - cursor)), 'accounting');
      const next = await rewards.poolRewardIndexNextEpoch(agentId);
      if (next <= cursor) throw new Error('Reward preparation made no progress. Retry the claim later.');
      cursor = next;
    }
  }
  const ids: number[] = [];
  for (const position of rewardedPositions) {
    if (await rewards.pendingIndexedStakerReward(position.id) > 0n) ids.push(position.id);
  }
  for (let offset = 0; offset < ids.length; offset += 32) {
    await record(await rewards.claimStakerRewardsBatch(wallet, ids.slice(offset, offset + 32), recipient), 'claim');
  }
}

export class RewardClaimProgress {
  claimed = 0n;
  transactions: string[] = [];

  constructor(
    private readonly report: (hash: string, kind: 'claim' | 'accounting') => void,
    private readonly received: (hash: string) => Promise<bigint>,
  ) {}

  record: RewardTransactionRecorder = async (hash, kind) => {
    this.transactions.push(hash);
    this.report(hash, kind);
    if (kind === 'claim') this.claimed += await this.received(hash);
  };

  failure(message: string): string {
    if (this.transactions.length === 0) return `Claim failed: ${message}`;
    return `Claim incomplete: ${this.transactions.length} transaction(s) already confirmed (shown above). ${message}. Re-run the claim to collect remaining rewards.`;
  }
}
