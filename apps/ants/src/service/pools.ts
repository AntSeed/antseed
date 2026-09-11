import { Interface, ZeroAddress } from 'ethers';
import { multicallRead, type MulticallRequest } from '@antseed/node/payments';
import type { AntsContext, ResolvedStack } from './context.js';
import type { PoolsView, PoolView, EpochVolume, SellerProfile } from '../api-types.js';
import { toJson } from './json.js';
import { explorerSellers, type ExplorerSellers } from './explorer.js';
import { mergePools, sortPools } from './pool-merge.js';
import { IndexerError } from './indexer.js';

const VOLUME_EPOCHS = 3;

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); } catch { return fallback; }
}

function bps(part: bigint, whole: bigint): number {
  return whole === 0n ? 0 : Number(part * 10_000n / whole);
}

function per1k(reward: bigint, power: bigint): string | null {
  return power === 0n ? null : (reward * 1_000n * 10n ** 18n / power).toString();
}

const POOLS_IFACE = new Interface([
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function currentPoolSecurityShareBps(uint256 agentId) returns (uint256)',
  'function stakerAgentActiveStake(address staker, uint256 agentId) view returns (uint256)',
  'function positionWeightAtEpoch(uint256 positionId, uint256 epoch) view returns (uint256)',
]);
const REGISTRY_IFACE = new Interface([
  'function agentSeller(uint256 agentId) view returns (address)',
  'function getAgentId(address seller) view returns (uint256)',
]);
const IDENTITY_IFACE = new Interface(['function ownerOf(uint256 agentId) view returns (address)']);
const ACCOUNTING_IFACE = new Interface([
  'function agentEpochUsage(uint256 epoch, uint256 agentId) view returns (tuple(uint256 points, uint256 weightedPoints))',
  'function totalWeightedPoolPointsByEpoch(uint256 epoch) view returns (uint256)',
  'function sellerPointsByEpoch(uint256 epoch, address seller) view returns (uint256)',
  'function totalSellerPointsByEpoch(uint256 epoch) view returns (uint256)',
]);
const REWARDS_IFACE = new Interface([
  'function poolEpochEmissions(uint256 epoch, uint256 agentId) view returns (bool, uint256)',
  'function stakerEpochBudget(uint256 epoch) view returns (uint256)',
]);
const LEGACY_IFACE = new Interface([
  'function userSellerPoints(address account, uint256 epoch) view returns (uint256)',
  'function epochTotalSellerPoints(uint256 epoch) view returns (uint256)',
]);

/** Collects multicall requests and hands back typed readers once the batch has run. */
class Batch {
  private readonly requests: MulticallRequest[] = [];
  private results: Array<unknown[] | null> = [];
  add(target: string | null | undefined, iface: Interface, method: string, args: unknown[]): () => unknown[] | null {
    if (!target || target === ZeroAddress) return () => null;
    const index = this.requests.length;
    this.requests.push({ target, iface, method, args });
    return () => this.results[index] ?? null;
  }
  async run(ctx: AntsContext): Promise<void> {
    this.results = await multicallRead(ctx.requirePools().provider, this.requests);
  }
}

const big = (read: () => unknown[] | null, index = 0): bigint => {
  const value = read()?.[index];
  return typeof value === 'bigint' ? value : 0n;
};

function volumeCall(ctx: AntsContext, stack: ResolvedStack, batch: Batch, epoch: number, seller: string | null): () => unknown[] | null {
  const effective = stack.effectiveEpoch ?? Number.MAX_SAFE_INTEGER;
  const recognized = stack.phase === 'active' && epoch >= effective;
  if (recognized) {
    return seller
      ? batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'sellerPointsByEpoch', [epoch, seller])
      : batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'totalSellerPointsByEpoch', [epoch]);
  }
  return seller
    ? batch.add(stack.legacyEmissions, LEGACY_IFACE, 'userSellerPoints', [seller, epoch])
    : batch.add(stack.legacyEmissions, LEGACY_IFACE, 'epochTotalSellerPoints', [epoch]);
}

interface PoolContext {
  stack: ResolvedStack;
  epochs: number[];
  totalPowerWeight: bigint;
  stakerBudget: bigint;
  totalWeightedPoolPoints: bigint;
  /** Previous epoch's staker budget and weighted pool points, for estimating unsettled pool emissions. */
  lastStakerBudget: bigint;
  lastTotalWeightedPoolPoints: bigint;
  explorer: ExplorerSellers;
  ownPositions: Map<number, number[]>;
}

async function poolContext(ctx: AntsContext): Promise<PoolContext> {
  const stack = await ctx.stack();
  const pools = ctx.requirePools();
  const poolRewards = ctx.poolRewards();
  const accounting = ctx.usageAccounting();
  const epoch = stack.currentEpoch;
  const epochs = Array.from({ length: VOLUME_EPOCHS }, (_, index) => epoch - index).filter((value) => value >= 0);
  const [totalPowerWeight, stakerBudget, totalWeightedPoolPoints, lastStakerBudget, lastTotalWeightedPoolPoints, explorer, own] = await Promise.all([
    safe(() => pools.totalPowerWeightAtEpoch(epoch), 0n),
    poolRewards ? safe(() => poolRewards.stakerEpochBudget(epoch), 0n) : Promise.resolve(0n),
    accounting ? safe(() => accounting.totalWeightedPoolPointsByEpoch(epoch), 0n) : Promise.resolve(0n),
    poolRewards && epoch > 0 ? safe(() => poolRewards.stakerEpochBudget(epoch - 1), 0n) : Promise.resolve(0n),
    accounting && epoch > 0 ? safe(() => accounting.totalWeightedPoolPointsByEpoch(epoch - 1), 0n) : Promise.resolve(0n),
    explorerSellers(ctx.chain.explorerApiUrl),
    pools.positionsBatch(await pools.allStakerPositionIds(ctx.address)),
  ]);
  const ownPositions = new Map<number, number[]>();
  for (const position of own) {
    if (position.withdrawn || position.closedAtEpoch !== 0) continue;
    ownPositions.set(position.agentId, [...(ownPositions.get(position.agentId) ?? []), position.id]);
  }
  return { stack, epochs, totalPowerWeight, stakerBudget, totalWeightedPoolPoints, lastStakerBudget, lastTotalWeightedPoolPoints, explorer, ownPositions };
}

/**
 * The stake gate `AntseedSellerPools.stake` actually enforces: the ERC-8004
 * agent must have an owner, and the seller registry must resolve that owner to
 * the agent — through the new `agentSeller` binding or its fallback to the
 * legacy USDC staking contract, which still covers sellers that registered
 * before the pool migration. Entries are present only where both reads
 * succeeded; callers fall back to the indexer's `registered` flag for the rest.
 */
async function stakeableAgents(ctx: AntsContext, agentIds: number[]): Promise<Map<number, boolean>> {
  const registryAddress = ctx.chain.sellerRegistryAddress;
  const identityAddress = ctx.chain.identityRegistryAddress;
  const stakeable = new Map<number, boolean>();
  if (!registryAddress || !identityAddress || agentIds.length === 0) return stakeable;
  const owners = new Batch();
  const ownerReads = agentIds.map((agentId) => ({ agentId, owner: owners.add(identityAddress, IDENTITY_IFACE, 'ownerOf', [agentId]) }));
  await owners.run(ctx);
  const bindings = new Batch();
  const bindingReads = new Map<string, () => unknown[] | null>();
  for (const read of ownerReads) {
    const owner = read.owner()?.[0] as string | undefined;
    if (!owner || owner === ZeroAddress) continue;
    const key = owner.toLowerCase();
    if (!bindingReads.has(key)) bindingReads.set(key, bindings.add(registryAddress, REGISTRY_IFACE, 'getAgentId', [owner]));
  }
  await bindings.run(ctx);
  for (const read of ownerReads) {
    const owner = read.owner()?.[0] as string | undefined;
    if (!owner || owner === ZeroAddress) continue;
    const resolved = bindingReads.get(owner.toLowerCase())?.();
    if (!resolved) continue;
    stakeable.set(read.agentId, Number(resolved[0]) === read.agentId);
  }
  return stakeable;
}

/**
 * Describe many pools in two multicall rounds. Round one is cheap for every
 * candidate (seller binding + current power); round two reads the full
 * analytics only for agents with a pool, a binding, or your stake, and just
 * the settled volume for the rest (explorer sellers without a pool yet).
 */
async function describePools(ctx: AntsContext, agentIds: number[], context: PoolContext): Promise<PoolView[]> {
  const poolsAddress = ctx.requirePools().contractAddress;
  const epoch = context.stack.currentEpoch;
  const first = new Batch();
  const firstReads = agentIds.map((agentId) => ({
    seller: first.add(ctx.chain.sellerRegistryAddress, REGISTRY_IFACE, 'agentSeller', [agentId]),
    weight: first.add(poolsAddress, POOLS_IFACE, 'poolWeightAtEpoch', [agentId, epoch]),
  }));
  await first.run(ctx);
  const stakeable = await stakeableAgents(ctx, agentIds);
  const resolved = agentIds.map((agentId, index) => {
    const read = firstReads[index]!;
    const registrySeller = (read.seller ? (read.seller()?.[0] as string | undefined) : undefined) ?? ZeroAddress;
    const isStakeable = stakeable.get(agentId) ?? false;
    const seller = registrySeller !== ZeroAddress ? registrySeller : context.explorer.byAgent.get(agentId) ?? null;
    const weight = big(read.weight);
    const yourIds = context.ownPositions.get(agentId) ?? [];
    return { agentId, stakeable: isStakeable, seller, weight, yourIds, full: weight !== 0n || isStakeable || yourIds.length > 0 };
  });

  const none = () => null;
  const batch = new Batch();
  const reads = resolved.map(({ agentId, seller, yourIds, full }) => ({
    activeStake: full ? batch.add(poolsAddress, POOLS_IFACE, 'poolActiveStakeAtEpoch', [agentId, epoch]) : none,
    lastWeight: full && epoch > 0 ? batch.add(poolsAddress, POOLS_IFACE, 'poolWeightAtEpoch', [agentId, epoch - 1]) : none,
    security: full ? batch.add(poolsAddress, POOLS_IFACE, 'currentPoolSecurityShareBps', [agentId]) : none,
    usage: full ? batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'agentEpochUsage', [epoch, agentId]) : none,
    lastUsage: full && epoch > 0 ? batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'agentEpochUsage', [epoch - 1, agentId]) : none,
    lastEmission: full && epoch > 0 ? batch.add(ctx.chain.sellerPoolsRewardsAddress, REWARDS_IFACE, 'poolEpochEmissions', [epoch - 1, agentId]) : none,
    yourStake: yourIds.length > 0 ? batch.add(poolsAddress, POOLS_IFACE, 'stakerAgentActiveStake', [ctx.address, agentId]) : none,
    yourWeights: yourIds.map((id) => batch.add(poolsAddress, POOLS_IFACE, 'positionWeightAtEpoch', [id, epoch])),
    volumes: context.epochs.map((value) => volumeCall(ctx, context.stack, batch, value, seller)),
  }));
  await batch.run(ctx);

  return resolved.map(({ agentId, stakeable, seller, weight, yourIds }, index) => {
    const read = reads[index]!;
    const lastWeight = big(read.lastWeight);
    const usage = read.usage()?.[0] as unknown as [bigint, bigint] | undefined;
    const points = usage?.[0] ?? 0n;
    const weightedPoints = usage?.[1] ?? 0n;
    const lastUsage = read.lastUsage()?.[0] as unknown as [bigint, bigint] | undefined;
    const lastPoints = lastUsage?.[0] ?? 0n;
    const lastWeightedPoints = lastUsage?.[1] ?? 0n;
    const emission = read.lastEmission();
    const settled = emission?.[0] === true;
    // Until a claim settles the pool's epoch, estimate its emission from last
    // epoch's weighted usage share of the staker budget (same math the contract applies).
    const emissionAmount = settled
      ? (emission?.[1] as bigint)
      : context.lastTotalWeightedPoolPoints > 0n ? context.lastStakerBudget * lastWeightedPoints / context.lastTotalWeightedPoolPoints : 0n;
    const yourPower = read.yourWeights.reduce((sum, weightRead) => sum + big(weightRead), 0n);
    const projected = context.totalWeightedPoolPoints > 0n && weightedPoints > 0n
      ? context.stakerBudget * weightedPoints / context.totalWeightedPoolPoints
      : 0n;
    const profile: SellerProfile | null = seller ? context.explorer.byAddress.get(seller.toLowerCase()) ?? null : null;
    return {
      agentId,
      seller,
      profile,
      hasPool: weight !== 0n,
      stakeable,
      activeStake: big(read.activeStake).toString(),
      weight: weight.toString(),
      powerShareBps: bps(weight, context.totalPowerWeight),
      securityShareBps: Number(big(read.security)),
      volumes: context.epochs.map((value, position): EpochVolume => ({ epoch: value, usdc: big(read.volumes[position]!).toString() })),
      usagePoints: points.toString(),
      weightedUsagePoints: weightedPoints.toString(),
      lastEpochUsagePoints: lastPoints.toString(),
      lastEpochEmission: emissionAmount > 0n ? emissionAmount.toString() : null,
      lastEpochEmissionSettled: settled,
      lastEpochRewardPer1kPower: emissionAmount > 0n ? per1k(emissionAmount, lastWeight) : null,
      projectedRewardPer1kPower: projected > 0n ? per1k(projected, weight) : null,
      yourStake: big(read.yourStake).toString(),
      yourPower: yourPower.toString(),
      yourPoolShareBps: bps(yourPower, weight),
      yourPositionIds: yourIds,
    };
  });
}

async function networkVolumes(ctx: AntsContext, stack: ResolvedStack, epochs: number[]): Promise<EpochVolume[]> {
  const batch = new Batch();
  const reads = epochs.map((epoch) => volumeCall(ctx, stack, batch, epoch, null));
  await batch.run(ctx);
  return epochs.map((epoch, index) => ({ epoch, usdc: big(reads[index]!).toString() }));
}

/** Your open positions grouped by agent, with each position's live power this epoch (a bounded read: only your ids). */
async function ownPools(ctx: AntsContext, context: PoolContext): Promise<Map<number, { positionIds: number[]; power: bigint; stake: bigint }>> {
  const poolsAddress = ctx.requirePools().contractAddress;
  const epoch = context.stack.currentEpoch;
  const batch = new Batch();
  const reads = [...context.ownPositions.entries()].map(([agentId, ids]) => ({
    agentId,
    ids,
    stake: batch.add(poolsAddress, POOLS_IFACE, 'stakerAgentActiveStake', [ctx.address, agentId]),
    weights: ids.map((id) => batch.add(poolsAddress, POOLS_IFACE, 'positionWeightAtEpoch', [id, epoch])),
  }));
  await batch.run(ctx);
  return new Map(reads.map((read) => [read.agentId, { positionIds: read.ids, stake: big(read.stake), power: read.weights.reduce((sum, weight) => sum + big(weight), 0n) }]));
}

/**
 * Pool comparison. Statistics for every pool come from the indexer; the
 * chain is read only for this wallet's own positions. Without an indexer
 * (or while it is down) only the pools this wallet stakes in are listed,
 * described live, and `source` says so.
 */
export async function poolsView(ctx: AntsContext): Promise<PoolsView> {
  const context = await poolContext(ctx);
  const indexer = ctx.indexer();
  const epochs = context.epochs;
  const base = {
    currentEpoch: context.stack.currentEpoch,
    firstRewardedEpoch: context.stack.effectiveEpoch,
    stakerBudget: context.stakerBudget.toString(),
    explorer: ctx.chain.explorerApiUrl ?? null,
  };
  if (indexer) {
    try {
      const [indexed, sellerEpochs, metrics, own] = await Promise.all([indexer.pools(), indexer.sellerEpochs(VOLUME_EPOCHS), indexer.epochMetrics(), ownPools(ctx, context)]);
      // The indexer's `registered` flag mirrors the new agentSeller binding
      // only; verify stakeability against the chain so sellers bound through
      // the registry's legacy USDC-staking fallback are not misreported.
      const agentIds = [...new Set([...indexed.pools.map((pool) => pool.agentId), ...context.explorer.byAgent.keys(), ...own.keys()])];
      const stakeable = await stakeableAgents(ctx, agentIds);
      const views = mergePools({ indexed, explorer: context.explorer, sellerEpochs, epochs, own, stakeable });
      const totalPower = BigInt(indexed.network.current?.totalPowerWeight ?? '0') || context.totalPowerWeight;
      const yourTotalPower = [...own.values()].reduce((sum, entry) => sum + entry.power, 0n);
      return toJson({
        ...base,
        totalActiveStake: indexed.network.current?.totalActiveStake ?? '0',
        totalPowerWeight: totalPower.toString(),
        networkVolumes: epochs.map((epoch): EpochVolume => ({ epoch, usdc: metrics.find((row) => row.epoch === epoch)?.volumeUsdc ?? '0' })),
        yourTotalPower: yourTotalPower.toString(),
        yourNetworkShareBps: bps(yourTotalPower, totalPower),
        source: 'indexer',
        sourceError: null,
        pools: views,
      });
    } catch (error) {
      if (!(error instanceof IndexerError)) throw error;
      return chainOnlyPools(ctx, context, base, error.message);
    }
  }
  return chainOnlyPools(ctx, context, base, null);
}

async function chainOnlyPools(
  ctx: AntsContext,
  context: PoolContext,
  base: Pick<PoolsView, 'currentEpoch' | 'firstRewardedEpoch' | 'stakerBudget' | 'explorer'>,
  sourceError: string | null,
): Promise<PoolsView> {
  const pools = ctx.requirePools();
  const agentIds = [...context.ownPositions.keys()];
  const views = sortPools(await describePools(ctx, agentIds, context));
  const [totalActiveStake, network] = await Promise.all([
    safe(() => pools.totalActiveStakeAtEpoch(context.stack.currentEpoch), 0n),
    networkVolumes(ctx, context.stack, context.epochs),
  ]);
  const yourTotalPower = views.reduce((sum, pool) => sum + BigInt(pool.yourPower), 0n);
  return toJson({
    ...base,
    totalActiveStake: totalActiveStake.toString(),
    totalPowerWeight: context.totalPowerWeight.toString(),
    networkVolumes: network,
    yourTotalPower: yourTotalPower.toString(),
    yourNetworkShareBps: bps(yourTotalPower, context.totalPowerWeight),
    source: 'chain',
    sourceError,
    pools: views,
  });
}

export async function singlePool(ctx: AntsContext, agentId: number): Promise<PoolView & { currentEpoch: number }> {
  const context = await poolContext(ctx);
  const indexer = ctx.indexer();
  if (indexer) {
    try {
      const [indexed, sellerEpochs, own] = await Promise.all([indexer.pools(), indexer.sellerEpochs(VOLUME_EPOCHS), ownPools(ctx, context)]);
      const ownHere = new Map([...own.entries()].filter(([id]) => id === agentId));
      const explorer = { byAddress: context.explorer.byAddress, byAgent: new Map([...context.explorer.byAgent.entries()].filter(([id]) => id === agentId)) };
      const stakeable = await stakeableAgents(ctx, [agentId]);
      const merged = mergePools({ indexed: { ...indexed, pools: indexed.pools.filter((pool) => pool.agentId === agentId) }, explorer, sellerEpochs, epochs: context.epochs, own: ownHere, stakeable });
      const view = merged.find((pool) => pool.agentId === agentId);
      if (view) return toJson({ ...view, currentEpoch: context.stack.currentEpoch });
    } catch (error) {
      if (!(error instanceof IndexerError)) throw error;
    }
  }
  const [view] = await describePools(ctx, [agentId], context);
  return toJson({ ...view!, currentEpoch: context.stack.currentEpoch });
}
