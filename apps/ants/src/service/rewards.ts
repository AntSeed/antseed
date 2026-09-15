import { ZeroAddress } from 'ethers';
import { claimEpochRewards, pendingEpochRewards, previewPoolRewards, type SellerPoolsClient, type SellerPoolsRewardsClient } from '@antseed/node/payments';
import type { AbstractSigner } from 'ethers';
import type { AntsContext } from './context.js';
import { closedPositionIds, requireStakeableAgent } from './positions.js';
import { IndexerError } from './indexer.js';
import type { RewardsView, ClaimRequest, RestakeRequest, StakeUsageRequest, EpochAmount, RewardBucket } from '../api-types.js';
import { formatAnts } from './format.js';
import { toJson } from './json.js';
import { assertAgentId, assertEpochs, assertPositiveIds, silentReporter, type StepReporter } from './steps.js';

const MAX_EPOCH_BREAKDOWN = 64;

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); } catch { return fallback; }
}

function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

async function agentIdOf(ctx: AntsContext): Promise<number> {
  const stack = await ctx.stack();
  const registry = ctx.sellerRegistry();
  const fromRegistry = registry ? await safe(() => registry.getAgentId(ctx.address), 0) : 0;
  if (fromRegistry) return fromRegistry;
  const legacy = ctx.legacyStakingAt(stack.legacyStaking);
  return legacy ? safe(() => legacy.getAgentId(ctx.address), 0) : 0;
}

/** Recognized epochs in which this wallet has indexed buyer or seller points; all of them without an indexer. */
async function usageEpochsOf(ctx: AntsContext, recognized: number[]): Promise<number[]> {
  const indexer = ctx.indexer();
  if (!indexer || recognized.length === 0) return recognized;
  try {
    const participant = await indexer.participant(ctx.address, recognized.length);
    const active = new Set([...participant.seller.map((row) => row.epoch), ...participant.buyer.map((row) => row.epoch)]);
    return recognized.filter((epoch) => active.has(epoch));
  } catch (error) {
    if (error instanceof IndexerError) return recognized;
    throw error;
  }
}

async function buyerOperator(ctx: AntsContext): Promise<string | null> {
  const deposits = ctx.deposits();
  if (!deposits) return null;
  const operator = await safe(() => deposits.getOperator(ctx.address), ZeroAddress);
  return sameAddress(operator, ZeroAddress) ? null : operator;
}

export async function rewards(ctx: AntsContext): Promise<RewardsView> {
  const stack = await ctx.stack();
  const epochs = await ctx.claimableEpochs();
  const pools = ctx.pools();
  const poolRewards = ctx.poolRewards();
  const usageAccounting = ctx.usageAccounting();
  const usageRewards = ctx.usageRewards();
  const legacy = ctx.legacyEmissionsAt(stack.legacyEmissions);
  const locked = ctx.lockedPoolAt(stack.lockedRewardsPool);
  const agentId = await agentIdOf(ctx);

  const closed = await closedPositionIds(ctx);
  const stakerPositions = pools && poolRewards
    ? await safe(() => previewPoolRewards(pools, poolRewards, ctx.address, undefined, { includeIds: closed.ids }), [])
    : [];
  const stakerTotal = stakerPositions.reduce((sum, position) => sum + position.amount, 0n);

  const sellerEpochs: EpochAmount[] = [];
  let sellerTotal = 0n;
  const buyerEpochs: EpochAmount[] = [];
  let buyerTotal = 0n;
  if (stack.phase === 'active' && usageAccounting && epochs.recognized.length > 0) {
    const pending = await safe(() => pendingEpochRewards(epochs.recognized, async (batch) => (await usageAccounting.pendingEmissions(ctx.address, batch)).seller), 0n);
    sellerTotal = pending;
    // Only epochs where this wallet actually earned points are checked per
    // epoch; the indexer knows which, so the loop stays bounded.
    const candidates = await usageEpochsOf(ctx, epochs.recognized);
    if (usageRewards && candidates.length <= MAX_EPOCH_BREAKDOWN) {
      const breakdown = await Promise.all(candidates.map(async (epoch) => {
        const [sellerClaimed, buyerClaimed] = await Promise.all([
          agentId ? safe(() => usageRewards.agentEpochClaimed(agentId, epoch), false) : Promise.resolve(false),
          safe(() => usageRewards.buyerEpochClaimed(ctx.address, epoch), false),
        ]);
        const [sellerAmount, buyerAmount] = await Promise.all([
          agentId && !sellerClaimed ? safe(() => usageRewards.pendingAgentReward(agentId, epoch), 0n) : Promise.resolve(0n),
          buyerClaimed ? Promise.resolve(0n) : safe(() => usageRewards.pendingBuyerReward(ctx.address, epoch), 0n),
        ]);
        return { epoch, sellerAmount, sellerClaimed, buyerAmount, buyerClaimed };
      }));
      for (const row of breakdown) {
        if (row.sellerAmount > 0n || row.sellerClaimed) sellerEpochs.push({ epoch: row.epoch, amount: row.sellerAmount.toString(), claimed: row.sellerClaimed });
        if (row.buyerAmount > 0n || row.buyerClaimed) buyerEpochs.push({ epoch: row.epoch, amount: row.buyerAmount.toString(), claimed: row.buyerClaimed });
        buyerTotal += row.buyerAmount;
      }
    } else if (usageRewards) {
      for (const epoch of candidates) {
        if (await safe(() => usageRewards.buyerEpochClaimed(ctx.address, epoch), false)) continue;
        buyerTotal += await safe(() => usageRewards.pendingBuyerReward(ctx.address, epoch), 0n);
      }
    }
  }
  const operator = await buyerOperator(ctx);

  let legacySeller = 0n;
  let legacyBuyer = 0n;
  if (legacy && epochs.legacy.length > 0) {
    const pending = await safe(() => pendingEpochRewards(epochs.legacy, async (batch) => {
      const result = await legacy.pendingEmissions(ctx.address, batch);
      legacyBuyer += result.buyer;
      return result.seller;
    }), 0n);
    legacySeller = pending;
  }

  const lockedInfo = locked ? await safe(() => locked.claimable(ctx.address), { locked: 0n, claimable: 0n, policy: ZeroAddress }) : { locked: 0n, claimable: 0n, policy: ZeroAddress };

  const total = stakerTotal + sellerTotal + buyerTotal + legacySeller + legacyBuyer + lockedInfo.claimable;
  return toJson({
    currentEpoch: stack.currentEpoch,
    firstRewardedEpoch: stack.effectiveEpoch,
    staker: {
      total: stakerTotal.toString(),
      positions: stakerPositions.filter((position) => position.amount > 0n).map((position) => ({ id: position.id, agentId: position.agentId, amount: position.amount.toString(), closed: position.closedAtEpoch !== 0 })),
    },
    sellerUsage: { total: sellerTotal.toString(), agentId, epochs: sellerEpochs, claimable: stack.phase === 'active' && agentId !== 0 },
    buyerUsage: {
      total: buyerTotal.toString(), epochs: buyerEpochs, operator,
      claimable: stack.phase === 'active' && sameAddress(operator, ctx.address), recipient: operator,
    },
    legacy: { seller: legacySeller.toString(), buyer: legacyBuyer.toString(), contract: stack.legacyEmissions, buyerClaimable: sameAddress(operator, ctx.address) || operator === null },
    locked: {
      locked: lockedInfo.locked.toString(), claimable: lockedInfo.claimable.toString(),
      policy: sameAddress(lockedInfo.policy, ZeroAddress) ? null : lockedInfo.policy, pool: stack.lockedRewardsPool,
    },
    total: total.toString(),
  });
}

/** Bring every pool's reward index up to the epoch the given positions need before claiming or restaking. */
async function preparePoolIndexes(
  pools: SellerPoolsClient,
  poolRewards: SellerPoolsRewardsClient,
  signer: AbstractSigner,
  targets: Array<{ agentId: number; closedAtEpoch: number }>,
  report: StepReporter,
): Promise<void> {
  const currentEpoch = await pools.currentEpoch();
  for (const agentId of new Set(targets.map((target) => target.agentId))) {
    const targetEpoch = targets.filter((target) => target.agentId === agentId)
      .reduce((latest, target) => Math.max(latest, Math.min(currentEpoch, target.closedAtEpoch || currentEpoch)), 0);
    let cursor = await poolRewards.poolRewardIndexNextEpoch(agentId) || await poolRewards.initialIndexEpoch();
    while (cursor < targetEpoch) {
      await report(`Indexing pool ${agentId} rewards (epochs ${cursor}…${Math.min(targetEpoch, cursor + 16) - 1})`);
      const hash = await poolRewards.indexPoolRewards(signer, agentId, Math.min(16, targetEpoch - cursor));
      await report('Index transaction confirmed', hash);
      const next = await poolRewards.poolRewardIndexNextEpoch(agentId);
      if (next <= cursor) throw new Error('Reward indexing made no progress; retry later.');
      cursor = next;
    }
  }
}

export interface ClaimResult { claimed: string; transactions: string[]; buckets: RewardBucket[]; }

export async function claim(ctx: AntsContext, request: ClaimRequest, report: StepReporter = silentReporter): Promise<ClaimResult> {
  const signer = ctx.requireSigner();
  const stack = await ctx.stack();
  const epochs = await ctx.claimableEpochs();
  const recipient = request.recipient ?? ctx.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('Recipient must be an address.');
  const buckets = request.buckets.length > 0 ? request.buckets : (['staker', 'seller', 'buyer', 'legacy', 'locked'] as RewardBucket[]);
  const token = ctx.antsToken();
  const transactions: string[] = [];
  let claimed = 0n;
  const record = async (hash: string, label: string, credit = true) => {
    transactions.push(hash);
    if (credit) claimed += await safe(() => token.receivedInTransaction(hash, recipient), 0n);
    await report(label, hash);
  };

  if (buckets.includes('staker')) {
    const pools = ctx.pools();
    const poolRewards = ctx.poolRewards();
    if (pools && poolRewards) {
      const closed = await closedPositionIds(ctx);
      const pending = (await previewPoolRewards(pools, poolRewards, ctx.address, undefined, { includeIds: closed.ids })).filter((position) => position.amount > 0n);
      if (pending.length > 0) {
        await preparePoolIndexes(pools, poolRewards, signer, pending, report);
        const ids: number[] = [];
        for (const position of pending) if (await poolRewards.pendingIndexedStakerReward(position.id) > 0n) ids.push(position.id);
        for (let offset = 0; offset < ids.length; offset += 32) {
          const batch = ids.slice(offset, offset + 32);
          await report(`Claiming staker rewards for position(s) ${batch.join(', ')}`);
          await record(await poolRewards.claimStakerRewardsBatch(signer, batch, recipient), 'Staker rewards claimed');
        }
      }
    }
  }

  if (buckets.includes('seller') && stack.phase === 'active') {
    const usageAccounting = ctx.usageAccounting();
    if (usageAccounting && epochs.recognized.length > 0) {
      await claimEpochRewards(epochs.recognized,
        async (batch) => (await usageAccounting.pendingEmissions(ctx.address, batch)).seller,
        async (batch) => { await report(`Claiming seller usage rewards for epochs ${batch[0]}…${batch[batch.length - 1]}`); return usageAccounting.claimSellerEmissions(signer, batch); },
        async (hash) => record(hash, 'Seller usage rewards claimed'));
    }
  }

  if (buckets.includes('buyer') && stack.phase === 'active') {
    const usageRewards = ctx.usageRewards();
    if (usageRewards) {
      const operator = await buyerOperator(ctx);
      if (operator && !sameAddress(operator, ctx.address)) {
        await report(`Buyer usage rewards are paid to the deposits operator ${operator}; claim them from that wallet.`);
      } else {
        for (const epoch of epochs.recognized) {
          if (await safe(() => usageRewards.buyerEpochClaimed(ctx.address, epoch), true)) continue;
          if (await safe(() => usageRewards.pendingBuyerReward(ctx.address, epoch), 0n) === 0n) continue;
          await report(`Claiming buyer usage reward for epoch ${epoch}`);
          await record(await usageRewards.claimBuyerReward(signer, ctx.address, epoch), 'Buyer usage reward claimed');
        }
      }
    }
  }

  if (buckets.includes('legacy')) {
    const legacy = ctx.legacyEmissionsAt(stack.legacyEmissions);
    if (legacy && epochs.legacy.length > 0) {
      await claimEpochRewards(epochs.legacy,
        async (batch) => (await legacy.pendingEmissions(ctx.address, batch)).seller,
        async (batch) => { await report(`Claiming legacy seller emissions for epochs ${batch[0]}…${batch[batch.length - 1]}`); return legacy.claimSellerEmissions(signer, batch); },
        async (hash) => record(hash, 'Legacy seller emissions claimed'));
      await claimEpochRewards(epochs.legacy,
        async (batch) => (await legacy.pendingEmissions(ctx.address, batch)).buyer,
        async (batch) => { await report(`Claiming legacy buyer emissions for epochs ${batch[0]}…${batch[batch.length - 1]}`); return legacy.claimBuyerEmissions(signer, ctx.address, batch); },
        async (hash) => record(hash, 'Legacy buyer emissions claimed'));
    }
  }

  if (buckets.includes('locked')) {
    const locked = ctx.lockedPoolAt(stack.lockedRewardsPool);
    if (locked) {
      const info = await safe(() => locked.claimable(ctx.address), { locked: 0n, claimable: 0n, policy: ZeroAddress });
      if (info.claimable > 0n) {
        await report(`Releasing ${formatAnts(info.claimable)} ANTS from the locked legacy rewards pool`);
        await record(await locked.claim(signer, recipient), 'Locked rewards released');
      }
    }
  }

  ctx.invalidate();
  return { claimed: claimed.toString(), transactions, buckets };
}

export interface RestakeResult { transactions: string[]; positionIds: number[]; epochs: number; }

export async function restake(ctx: AntsContext, request: RestakeRequest, report: StepReporter = silentReporter): Promise<RestakeResult> {
  const signer = ctx.requireSigner();
  const pools = ctx.requirePools();
  const poolRewards = ctx.requirePoolRewards();
  const config = await pools.poolConfig();
  const epochs = assertEpochs(request.epochs, config.minStakeEpochs, config.maxStakeEpochs);
  const requested = request.positionIds && request.positionIds.length > 0 ? assertPositiveIds(request.positionIds) : null;
  const includeIds = requested ?? (await closedPositionIds(ctx)).ids;
  const pending = (await previewPoolRewards(pools, poolRewards, ctx.address, undefined, { includeIds }))
    .filter((position) => position.amount > 0n && (!requested || requested.includes(position.id)));
  if (pending.length === 0) throw new Error('No staker rewards to restake.');
  await preparePoolIndexes(pools, poolRewards, signer, pending, report);
  const ids: number[] = [];
  for (const position of pending) if (await poolRewards.pendingIndexedStakerReward(position.id) > 0n) ids.push(position.id);
  if (ids.length === 0) throw new Error('Rewards are not indexed yet; retry after the next epoch.');
  const transactions: string[] = [];
  for (let offset = 0; offset < ids.length; offset += 32) {
    const batch = ids.slice(offset, offset + 32);
    await report(`Restaking rewards from position(s) ${batch.join(', ')} for ${epochs} epoch(s)`);
    const hash = await poolRewards.restakeStakerRewardsBatch(signer, batch, epochs);
    transactions.push(hash);
    await report('Restake confirmed', hash);
  }
  ctx.invalidate();
  return { transactions, positionIds: ids, epochs };
}

export interface StakeUsageResult { transactions: string[]; epochsStaked: number[]; }

export async function stakeUsageRewards(ctx: AntsContext, request: StakeUsageRequest, report: StepReporter = silentReporter): Promise<StakeUsageResult> {
  const signer = ctx.requireSigner();
  const stack = await ctx.stack();
  if (stack.phase !== 'active') throw new Error('Usage rewards can be staked once recognized usage is active.');
  const pools = ctx.requirePools();
  const usageRewards = ctx.usageRewards();
  if (!usageRewards) throw new Error('Usage rewards contract is not configured.');
  const config = await pools.poolConfig();
  const epochs = assertEpochs(request.epochs, config.minStakeEpochs, config.maxStakeEpochs);
  const claimable = await ctx.claimableEpochs();
  const transactions: string[] = [];
  const epochsStaked: number[] = [];
  if (request.side === 'seller') {
    const agentId = await agentIdOf(ctx);
    if (!agentId) throw new Error('This wallet has no seller agent.');
    for (const epoch of claimable.recognized) {
      if (await safe(() => usageRewards.agentEpochClaimed(agentId, epoch), true)) continue;
      if (await safe(() => usageRewards.pendingAgentReward(agentId, epoch), 0n) === 0n) continue;
      await report(`Staking seller usage reward for epoch ${epoch} into agent ${agentId}`);
      const hash = await usageRewards.stakeAgentReward(signer, agentId, epoch, epochs);
      transactions.push(hash);
      epochsStaked.push(epoch);
      await report('Reward staked', hash);
    }
  } else {
    const stakeAgentId = assertAgentId(request.stakeAgentId);
    const operator = await buyerOperator(ctx);
    if (operator && !sameAddress(operator, ctx.address)) throw new Error(`Buyer usage rewards belong to the deposits operator ${operator}; stake them from that wallet.`);
    for (const epoch of claimable.recognized) {
      if (await safe(() => usageRewards.buyerEpochClaimed(ctx.address, epoch), true)) continue;
      if (await safe(() => usageRewards.pendingBuyerReward(ctx.address, epoch), 0n) === 0n) continue;
      await report(`Staking buyer usage reward for epoch ${epoch} into agent ${stakeAgentId}`);
      const hash = await usageRewards.stakeBuyerReward(signer, ctx.address, epoch, stakeAgentId, epochs);
      transactions.push(hash);
      epochsStaked.push(epoch);
      await report('Reward staked', hash);
    }
  }
  if (transactions.length === 0) throw new Error('No unclaimed usage rewards to stake.');
  ctx.invalidate();
  return { transactions, epochsStaked };
}

export interface CompoundRequest { epochs: number; targetAgentId?: number; stakeAgentId?: number; }
export interface CompoundResult { transactions: string[]; restakedPositionIds: number[]; sellerEpochs: number[]; buyerEpochs: number[]; newPositionIds: number[]; movedPositionIds: number[]; targetAgentId: number | null; }

/**
 * Restake everything that can be restaked in one job: indexed staker rewards
 * (with the restake weight bonus, into their source pools), seller usage
 * rewards into the seller's own pool, and buyer usage rewards into
 * `stakeAgentId` (default `targetAgentId`) when this wallet is the deposits
 * operator. When `targetAgentId` is given, every new position that landed in
 * another pool is then moved there (principal, lock, and bonus preserved;
 * the move takes effect next epoch). Legacy and locked-pool rewards have no
 * stake path and are left for `claim`.
 */
export async function compound(ctx: AntsContext, request: CompoundRequest, report: StepReporter = silentReporter): Promise<CompoundResult> {
  const pools = ctx.requirePools();
  const targetAgentId = request.targetAgentId === undefined ? null : assertAgentId(request.targetAgentId);
  if (targetAgentId !== null) await requireStakeableAgent(ctx, targetAgentId);
  const before = new Set(await pools.allStakerPositionIds(ctx.address));
  const result: CompoundResult = { transactions: [], restakedPositionIds: [], sellerEpochs: [], buyerEpochs: [], newPositionIds: [], movedPositionIds: [], targetAgentId };
  try {
    const restaked = await restake(ctx, { epochs: request.epochs }, report);
    result.transactions.push(...restaked.transactions);
    result.restakedPositionIds = restaked.positionIds;
  } catch (error) {
    if (!/No staker rewards|not indexed/.test((error as Error).message)) throw error;
    await report('No staker rewards to restake');
  }
  const stack = await ctx.stack();
  if (stack.phase === 'active') {
    const agentId = await agentIdOf(ctx);
    if (agentId) {
      try {
        const seller = await stakeUsageRewards(ctx, { side: 'seller', epochs: request.epochs }, report);
        result.transactions.push(...seller.transactions);
        result.sellerEpochs = seller.epochsStaked;
      } catch (error) {
        if (!/No unclaimed usage rewards/.test((error as Error).message)) throw error;
      }
    }
    const operator = await buyerOperator(ctx);
    if (sameAddress(operator, ctx.address)) {
      const stakeAgentId = request.stakeAgentId ?? targetAgentId ?? agentId;
      if (stakeAgentId) {
        try {
          const buyer = await stakeUsageRewards(ctx, { side: 'buyer', epochs: request.epochs, stakeAgentId }, report);
          result.transactions.push(...buyer.transactions);
          result.buyerEpochs = buyer.epochsStaked;
        } catch (error) {
          if (!/No unclaimed usage rewards/.test((error as Error).message)) throw error;
        }
      }
    }
  }
  if (result.transactions.length === 0) throw new Error('Nothing to restake.');
  const created = (await pools.allStakerPositionIds(ctx.address)).filter((id) => !before.has(id));
  result.newPositionIds = created;
  if (targetAgentId !== null && created.length > 0) {
    const positions = await pools.positionsBatch(created);
    const toMove = positions.filter((position) => position.agentId !== targetAgentId).map((position) => position.id);
    if (toMove.length > 0) {
      await report(`Moving ${toMove.length} new position(s) into agent ${targetAgentId} (effective next epoch)`);
      const hash = await pools.moveStakes(ctx.requireSigner(), toMove, targetAgentId);
      result.transactions.push(hash);
      result.movedPositionIds = toMove;
      await report('Move confirmed', hash);
    }
  }
  ctx.invalidate();
  return result;
}
