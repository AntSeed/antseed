import { ZeroAddress } from 'ethers';
import { estimateEarlyExit, positionState, projectedEarlyExitSlashBps, type SellerPoolPosition, type SellerPoolConfig } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import type { PositionView, PositionsView, StakeRequest, MoveRequest, SplitRequest, MergeRequest, ExtendRequest, MaxLockRequest, WithdrawRequest } from '../api-types.js';
import { parseAnts, formatAnts } from './format.js';
import { toJson } from './json.js';
import { IndexerError, type IndexedPosition } from './indexer.js';
import { assertAgentId, assertEpochs, assertPositiveIds, silentReporter, type StepReporter } from './steps.js';

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); } catch { return fallback; }
}

export interface PositionDetail extends PositionView { raw: SellerPoolPosition; }

async function describePositions(ctx: AntsContext, positions: SellerPoolPosition[], currentEpoch: number, config: SellerPoolConfig): Promise<PositionDetail[]> {
  const pools = ctx.requirePools();
  const poolRewards = ctx.poolRewards();
  // Closed positions keep the reward earned up to their close epoch, so every id is previewed.
  const rewardIds = positions.map((position) => position.id);
  const rewards = new Map<number, bigint>();
  if (poolRewards && rewardIds.length > 0) {
    const amounts = await safe(() => poolRewards.previewStakerRewards(rewardIds), rewardIds.map(() => 0n));
    rewardIds.forEach((id, index) => rewards.set(id, amounts[index] ?? 0n));
  }
  const details: PositionDetail[] = [];
  for (let offset = 0; offset < positions.length; offset += 8) {
    details.push(...await Promise.all(positions.slice(offset, offset + 8).map(async (position): Promise<PositionDetail> => {
      const open = !position.withdrawn && position.closedAtEpoch === 0;
      const [withdrawableEpoch, maxLocked] = await Promise.all([
        safe(() => pools.positionWithdrawableEpoch(position.id), 0),
        open ? safe(() => pools.isMaxLocked(position.id, Math.max(currentEpoch, position.stakeStartEpoch)), false) : Promise.resolve(false),
      ]);
      const changePending = currentEpoch < withdrawableEpoch;
      const slashBps = open && !changePending ? await safe<number | null>(() => pools.earlyExitSlashBps(position.id), null) : null;
      const projectedSlashBps = open ? projectedEarlyExitSlashBps(position, currentEpoch, config, maxLocked) : 0;
      const estimate = estimateEarlyExit(position, slashBps ?? projectedSlashBps);
      return {
        id: position.id,
        agentId: position.agentId,
        owner: position.owner,
        amount: position.amount.toString(),
        weightAmount: position.weightAmount.toString(),
        stakeStartEpoch: position.stakeStartEpoch,
        stakeEndEpoch: position.stakeEndEpoch,
        closedAtEpoch: position.closedAtEpoch,
        withdrawn: position.withdrawn,
        state: positionState(position, currentEpoch),
        withdrawableEpoch,
        changePending,
        maxLocked,
        slashBps,
        projectedSlashBps,
        slashedAmount: open ? estimate.slashedAmount.toString() : '0',
        returnedAmount: open ? estimate.returnedAmount.toString() : '0',
        pendingReward: (rewards.get(position.id) ?? 0n).toString(),
        epochsRemaining: open ? Math.max(0, position.stakeEndEpoch - Math.max(currentEpoch, position.stakeStartEpoch)) : 0,
        raw: position,
      };
    })));
  }
  return details.sort((a, b) => b.id - a.id);
}

/**
 * Ids of this wallet's positions that left the on-chain enumeration (split,
 * merge, move sources; withdrawals), as the indexer knows them. Empty without
 * an indexer; never reconstructed from log scans.
 */
export async function closedPositionIds(ctx: AntsContext): Promise<{ ids: number[]; source: PositionsView['historySource']; rows: IndexedPosition[] }> {
  const indexer = ctx.indexer();
  if (!indexer) return { ids: [], source: 'chain', rows: [] };
  try {
    const rows = (await indexer.positions(ctx.address, true)).filter((row) => row.closedAtEpoch !== 0 || row.withdrawn);
    return { ids: rows.map((row) => row.id), source: 'indexer', rows };
  } catch (error) {
    if (error instanceof IndexerError) return { ids: [], source: 'chain', rows: [] };
    throw error;
  }
}

/**
 * The wallet's open positions from the on-chain `stakerPositionIds`
 * enumeration, plus its closed positions from the indexer (with the reward
 * still pending on them read live). The chain is never scanned for history.
 */
export async function positions(ctx: AntsContext): Promise<PositionsView> {
  const stack = await ctx.stack();
  const pools = ctx.requirePools();
  const config = await pools.poolConfig();
  const [openIds, closed] = await Promise.all([pools.allStakerPositionIds(ctx.address), closedPositionIds(ctx)]);
  const list = await pools.positionsBatch([...new Set([...openIds, ...closed.ids])]);
  const details = await describePositions(ctx, list, stack.currentEpoch, config);
  const closedById = new Map(closed.rows.map((row) => [row.id, row]));
  const activeStake = details.filter((position) => position.state === 'active' || position.state === 'matured').reduce((sum, position) => sum + BigInt(position.amount), 0n);
  const pendingRewards = details.reduce((sum, position) => sum + BigInt(position.pendingReward), 0n);
  return toJson({
    currentEpoch: stack.currentEpoch,
    config,
    positions: details.map(({ raw: _raw, ...view }) => {
      const meta = closedById.get(view.id);
      return meta ? { ...view, closedBy: meta.closedBy, replacementIds: meta.replacementIds } : view;
    }),
    totals: { activeStake: activeStake.toString(), pendingRewards: pendingRewards.toString(), open: details.filter((position) => !position.withdrawn && position.closedAtEpoch === 0).length },
    historySource: closed.source,
  });
}

async function ownedOpenPositions(ctx: AntsContext, ids: number[]): Promise<SellerPoolPosition[]> {
  const pools = ctx.requirePools();
  const list = await pools.positionsBatch(ids);
  const foreign = list.filter((position) => position.owner.toLowerCase() !== ctx.address.toLowerCase());
  if (foreign.length > 0) throw new Error(`Position(s) ${foreign.map((position) => position.id).join(', ')} are not owned by this wallet.`);
  const closed = list.filter((position) => position.withdrawn || position.closedAtEpoch !== 0);
  if (closed.length > 0) throw new Error(`Position(s) ${closed.map((position) => position.id).join(', ')} are already closed or withdrawn.`);
  return list;
}

async function requireNoPendingChange(ctx: AntsContext, list: SellerPoolPosition[]): Promise<void> {
  const pools = ctx.requirePools();
  const stack = await ctx.stack();
  const pending: number[] = [];
  for (const position of list) {
    if (stack.currentEpoch < await pools.positionWithdrawableEpoch(position.id)) pending.push(position.id);
  }
  if (pending.length > 0) throw new Error(`Position(s) ${pending.join(', ')} changed this epoch; try again after the next epoch boundary.`);
}

/**
 * The gate `AntseedSellerPools.stake` enforces: the agent's ERC-8004 owner
 * must resolve to the agent in the seller registry — via the direct
 * `agentSeller` binding or the registry's fallback to the legacy USDC staking
 * contract. Checking `agentSeller` alone would reject legacy-bound sellers.
 */
export async function requireStakeableAgent(ctx: AntsContext, agentId: number): Promise<void> {
  const registry = ctx.sellerRegistry();
  if (!registry) return;
  const identity = ctx.identity();
  const owner = identity ? await identity.getAgentWallet(agentId).catch(() => null) : null;
  const seller = owner && owner !== ZeroAddress ? owner : await registry.agentSeller(agentId).catch(() => null);
  const resolved = seller && seller !== ZeroAddress ? await registry.getAgentId(seller).catch(() => 0) : 0;
  if (resolved !== agentId) {
    throw new Error(`Agent ${agentId} is not stakeable: the seller registry does not resolve the agent's owner to it. The owner must bind it with \`antseed seller register\` (sellers staked in the legacy USDC contract are bound automatically while they own the agent).`);
  }
}

export async function stake(ctx: AntsContext, request: StakeRequest, report: StepReporter = silentReporter): Promise<{ hash: string; amount: string; agentId: number; epochs: number }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const agentId = assertAgentId(request.agentId);
  const amount = parseAnts(String(request.amount));
  const config = await pools.poolConfig();
  const epochs = assertEpochs(request.epochs, config.minStakeEpochs, config.maxStakeEpochs);
  await requireStakeableAgent(ctx, agentId);
  const token = ctx.antsToken();
  const [balance, canTransfer] = await Promise.all([token.balanceOf(ctx.address), token.canTransfer(ctx.address)]);
  if (!canTransfer) throw new Error('ANTS transfers are not enabled for this wallet, so tokens cannot be moved into the pool yet.');
  if (balance < amount) throw new Error(`Insufficient ANTS: balance ${formatAnts(balance)} ANTS, requested ${formatAnts(amount)} ANTS.`);
  await report(`Approving and staking ${formatAnts(amount)} ANTS into agent ${agentId} for ${epochs} epoch(s)`);
  const hash = await pools.stake(signer, agentId, amount, epochs);
  await report('Stake confirmed', hash);
  ctx.invalidate();
  return { hash, amount: amount.toString(), agentId, epochs };
}

export async function move(ctx: AntsContext, request: MoveRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const ids = assertPositiveIds(request.positionIds);
  const toAgentId = assertAgentId(request.toAgentId);
  const list = await ownedOpenPositions(ctx, ids);
  const already = list.filter((position) => position.agentId === toAgentId);
  if (already.length > 0) throw new Error(`Position(s) ${already.map((position) => position.id).join(', ')} already stake agent ${toAgentId}.`);
  await requireNoPendingChange(ctx, list);
  await requireStakeableAgent(ctx, toAgentId);
  await report(`Moving ${ids.length} position(s) to agent ${toAgentId} (effective next epoch)`);
  const hash = ids.length === 1 ? await pools.moveStake(signer, ids[0]!, toAgentId) : await pools.moveStakes(signer, ids, toAgentId);
  await report('Move confirmed', hash);
  return { hash };
}

export async function split(ctx: AntsContext, request: SplitRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const [id] = assertPositiveIds([request.positionId]);
  const splitAmount = parseAnts(String(request.amount));
  const [position] = await ownedOpenPositions(ctx, [id!]);
  if (splitAmount >= position!.amount) throw new Error(`Split amount must be below the position's ${formatAnts(position!.amount)} ANTS.`);
  const secondWeight = position!.weightAmount * splitAmount / position!.amount;
  if (secondWeight === 0n || position!.weightAmount - secondWeight === 0n) throw new Error('Split amount is too small: both parts need non-zero weight.');
  await requireNoPendingChange(ctx, [position!]);
  await report(`Splitting ${formatAnts(splitAmount)} ANTS out of position ${id}`);
  const hash = await pools.splitStake(signer, id!, splitAmount);
  await report('Split confirmed', hash);
  return { hash };
}

export async function merge(ctx: AntsContext, request: MergeRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const ids = assertPositiveIds(request.positionIds);
  if (ids.length < 2) throw new Error('Merging needs at least two positions.');
  const list = await ownedOpenPositions(ctx, ids);
  const agents = new Set(list.map((position) => position.agentId));
  if (agents.size !== 1) throw new Error('All merged positions must stake the same agent pool.');
  const ends = new Set(list.map((position) => position.stakeEndEpoch));
  if (ends.size !== 1) throw new Error('All merged positions must share the same lock end epoch (extend or disable max lock first to align them).');
  await requireNoPendingChange(ctx, list);
  const stack = await ctx.stack();
  for (const position of list) {
    if (await pools.isMaxLocked(position.id, Math.max(stack.currentEpoch, position.stakeStartEpoch))) {
      throw new Error(`Position ${position.id} is max-locked; disable max lock before merging.`);
    }
  }
  await report(`Merging ${ids.length} positions in agent ${list[0]!.agentId}`);
  const hash = await pools.mergeStakes(signer, ids);
  await report('Merge confirmed', hash);
  return { hash };
}

export async function extend(ctx: AntsContext, request: ExtendRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const [id] = assertPositiveIds([request.positionId]);
  const config = await pools.poolConfig();
  const additional = assertEpochs(request.epochs, 1, config.maxStakeEpochs);
  const [position] = await ownedOpenPositions(ctx, [id!]);
  const stack = await ctx.stack();
  const effective = stack.currentEpoch + 1;
  const newEnd = Math.max(position!.stakeEndEpoch, effective) + additional;
  if (newEnd - effective > config.maxStakeEpochs) throw new Error(`The new lock end (epoch ${newEnd}) would exceed ${config.maxStakeEpochs} epochs from the next epoch.`);
  await report(`Extending position ${id} by ${additional} epoch(s) to epoch ${newEnd}`);
  const hash = await pools.extendLock(signer, id!, additional);
  await report('Extension confirmed', hash);
  return { hash };
}

export async function maxLock(ctx: AntsContext, request: MaxLockRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const [id] = assertPositiveIds([request.positionId]);
  const [position] = await ownedOpenPositions(ctx, [id!]);
  const stack = await ctx.stack();
  const locked = await pools.isMaxLocked(id!, Math.max(stack.currentEpoch + 1, position!.stakeStartEpoch));
  if (request.enable && locked) throw new Error(`Position ${id} is already max-locked.`);
  if (!request.enable && !locked) throw new Error(`Position ${id} is not max-locked.`);
  await report(request.enable ? `Enabling max lock on position ${id} (constant maximum power; withdrawal restarts the full countdown)` : `Disabling max lock on position ${id} (a fresh ${(await pools.poolConfig()).maxStakeEpochs}-epoch countdown starts next epoch)`);
  const hash = request.enable ? await pools.enableMaxLock(signer, id!) : await pools.disableMaxLock(signer, id!);
  await report('Max lock change confirmed', hash);
  return { hash };
}

export interface WithdrawPreview {
  positions: Array<{ id: number; amount: string; slashBps: number; slashedAmount: string; returnedAmount: string }>;
  totalSlashed: string;
  totalReturned: string;
  earlyExit: boolean;
}

export async function previewWithdraw(ctx: AntsContext, ids: number[]): Promise<WithdrawPreview> {
  const pools = ctx.requirePools();
  const list = await ownedOpenPositions(ctx, assertPositiveIds(ids));
  await requireNoPendingChange(ctx, list);
  const estimates = await Promise.all(list.map(async (position) => estimateEarlyExit(position, await pools.earlyExitSlashBps(position.id))));
  return {
    positions: estimates.map((estimate) => ({ id: estimate.id, amount: estimate.amount.toString(), slashBps: estimate.slashBps, slashedAmount: estimate.slashedAmount.toString(), returnedAmount: estimate.returnedAmount.toString() })),
    totalSlashed: estimates.reduce((sum, estimate) => sum + estimate.slashedAmount, 0n).toString(),
    totalReturned: estimates.reduce((sum, estimate) => sum + estimate.returnedAmount, 0n).toString(),
    earlyExit: estimates.some((estimate) => estimate.slashBps > 0),
  };
}

export async function withdraw(ctx: AntsContext, request: WithdrawRequest, report: StepReporter = silentReporter): Promise<{ hash: string; preview: WithdrawPreview }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const ids = assertPositiveIds(request.positionIds);
  const preview = await previewWithdraw(ctx, ids);
  if (preview.earlyExit) {
    if (!request.acceptSlashing) throw new Error(`Early exit burns an estimated ${formatAnts(preview.totalSlashed)} ANTS of principal. Re-run with slashing accepted to proceed.`);
    if (request.maxSlashedAmount !== undefined && BigInt(preview.totalSlashed) > BigInt(request.maxSlashedAmount)) {
      throw new Error('The slashing estimate increased since it was reviewed. Review the new estimate before withdrawing.');
    }
  }
  await report(preview.earlyExit
    ? `Withdrawing ${ids.length} position(s), burning about ${formatAnts(preview.totalSlashed)} ANTS`
    : `Withdrawing ${ids.length} matured position(s)`);
  const hash = await pools.withdrawStakes(signer, ids);
  await report('Withdrawal confirmed', hash);
  ctx.invalidate();
  return { hash, preview };
}
