import { closedPositionIds } from './positions.js';
import { poolYield } from './yield.js';
import { Interface, ZeroAddress } from 'ethers';
import { multicallRead, type MulticallRequest } from '@antseed/node/payments';
import type { AntsContext, ResolvedStack } from './context.js';
import type { PoolsView, PoolView, EpochVolume, SellerProfile } from '../api-types.js';
import { toJson } from './json.js';
import { explorerSellers, type ExplorerSellers } from './explorer.js';
import { mergePools, sortPools } from './pool-merge.js';
import { IndexerError, type IndexedPools } from './indexer.js';

const VOLUME_EPOCHS = 9;

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
  'function minStakeEpochs() view returns (uint256)',
  'function MAX_STAKE_EPOCHS() view returns (uint256)',
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function currentPoolSecurityShareBps(uint256 agentId) returns (uint256)',
  'function stakerAgentActiveStake(address staker, uint256 agentId) view returns (uint256)',
  'function positionWeightAtEpoch(uint256 positionId, uint256 epoch) view returns (uint256)',
]);
const REGISTRY_IFACE = new Interface(['function agentSeller(uint256 agentId) view returns (address)']);
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

async function poolContext(ctx: AntsContext, indexed?: IndexedPools): Promise<PoolContext> {
  const stack = await ctx.stack();
  const pools = ctx.requirePools();
  const poolRewards = ctx.poolRewards();
  const accounting = ctx.usageAccounting();
  const epoch = stack.currentEpoch;
  const current = indexed?.currentEpoch === epoch && indexed.network.current?.epoch === epoch && indexed.network.current.complete !== false ? indexed.network.current : null;
  const last = indexed?.currentEpoch === epoch && indexed.network.last?.epoch === epoch - 1 && indexed.network.last.complete !== false ? indexed.network.last : null;
  const epochs = Array.from({ length: VOLUME_EPOCHS }, (_, index) => epoch - index).filter((value) => value >= 0);
  const [totalPowerWeight, stakerBudget, totalWeightedPoolPoints, lastStakerBudget, lastTotalWeightedPoolPoints, explorer, own] = await Promise.all([
    current ? Promise.resolve(BigInt(current.totalPowerWeight)) : safe(() => pools.totalPowerWeightAtEpoch(epoch), 0n),
    current ? Promise.resolve(BigInt(current.stakerBudget)) : poolRewards ? safe(() => poolRewards.stakerEpochBudget(epoch), 0n) : Promise.resolve(0n),
    current ? Promise.resolve(BigInt(current.totalWeightedPoolPoints)) : accounting ? safe(() => accounting.totalWeightedPoolPointsByEpoch(epoch), 0n) : Promise.resolve(0n),
    last ? Promise.resolve(BigInt(last.stakerBudget)) : poolRewards && epoch > 0 ? safe(() => poolRewards.stakerEpochBudget(epoch - 1), 0n) : Promise.resolve(0n),
    last ? Promise.resolve(BigInt(last.totalWeightedPoolPoints)) : accounting && epoch > 0 ? safe(() => accounting.totalWeightedPoolPointsByEpoch(epoch - 1), 0n) : Promise.resolve(0n),
    explorerSellers(ctx.chain.explorerApiUrl),
    (async () => {
      if (ctx.address === ZeroAddress) return [];
      const [open, closed] = await Promise.all([pools.allStakerPositionIds(ctx.address), closedPositionIds(ctx)]);
      return pools.positionsBatch([...new Set([...open, ...closed.ids])]);
    })(),
  ]);
  const ownPositions = new Map<number, number[]>();
  for (const position of own) {
    // A moved/split source can still have power until its effective epoch.
    if (position.owner.toLowerCase() !== ctx.address.toLowerCase() || position.withdrawn || (position.closedAtEpoch !== 0 && position.closedAtEpoch <= epoch)) continue;
    ownPositions.set(position.agentId, [...(ownPositions.get(position.agentId) ?? []), position.id]);
  }
  return { stack, epochs, totalPowerWeight, stakerBudget, totalWeightedPoolPoints, lastStakerBudget, lastTotalWeightedPoolPoints, explorer, ownPositions };
}

/**
 * Describe many pools in two multicall rounds. Round one is cheap for every
 * candidate (seller binding + current power); round two reads the full
 * analytics only for agents with a pool, a binding, or your stake, and just
 * the settled volume for the rest (explorer sellers without a pool yet).
 */
async function describePools(ctx: AntsContext, agents: Array<[number, string | null]>, context: PoolContext): Promise<PoolView[]> {
  const poolsAddress = ctx.requirePools().contractAddress;
  const epoch = context.stack.currentEpoch;
  const first = new Batch();
  const firstReads = agents.map(([agentId, bound]) => ({
    seller: bound ? null : first.add(ctx.chain.sellerRegistryAddress, REGISTRY_IFACE, 'agentSeller', [agentId]),
    weight: first.add(poolsAddress, POOLS_IFACE, 'poolWeightAtEpoch', [agentId, epoch]),
  }));
  await first.run(ctx);
  const resolved = agents.map(([agentId, bound], index) => {
    const read = firstReads[index]!;
    const registrySeller = bound ?? (read.seller ? (read.seller()?.[0] as string | undefined) ?? ZeroAddress : ZeroAddress);
    const stakeable = !!registrySeller && registrySeller !== ZeroAddress;
    const seller = stakeable ? registrySeller : context.explorer.byAgent.get(agentId) ?? null;
    const weight = big(read.weight);
    const yourIds = context.ownPositions.get(agentId) ?? [];
    return { agentId, stakeable, seller, weight, yourIds, full: weight !== 0n || stakeable || yourIds.length > 0 };
  });

  const none = () => null;
  const batch = new Batch();
  const reads = resolved.map(({ agentId, yourIds, full }) => ({
    activeStake: full ? batch.add(poolsAddress, POOLS_IFACE, 'poolActiveStakeAtEpoch', [agentId, epoch]) : none,
    lastWeight: full && epoch > 0 ? batch.add(poolsAddress, POOLS_IFACE, 'poolWeightAtEpoch', [agentId, epoch - 1]) : none,
    security: full ? batch.add(poolsAddress, POOLS_IFACE, 'currentPoolSecurityShareBps', [agentId]) : none,
    usage: full ? batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'agentEpochUsage', [epoch, agentId]) : none,
    lastUsage: full && epoch > 0 ? batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'agentEpochUsage', [epoch - 1, agentId]) : none,
    lastEmission: full && epoch > 0 ? batch.add(ctx.chain.sellerPoolsRewardsAddress, REWARDS_IFACE, 'poolEpochEmissions', [epoch - 1, agentId]) : none,
    yourStake: yourIds.length > 0 ? batch.add(poolsAddress, POOLS_IFACE, 'stakerAgentActiveStake', [ctx.address, agentId]) : none,
    yourWeights: yourIds.map((id) => batch.add(poolsAddress, POOLS_IFACE, 'positionWeightAtEpoch', [id, epoch])),

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
      volumes: [],
      volumeStatus: 'unavailable' as const,
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
  const indexer = ctx.indexer();
  let indexerError: string | null = null;
  // Start public data immediately; do not put it behind wallet/reward RPC work.
  const indexed = indexer ? await indexer.pools().catch(error => {
    if (error instanceof IndexerError) { indexerError = error.message; return null; }
    throw error;
  }) : null;
  const context = await poolContext(ctx, indexed ?? undefined);
  const epochs = context.epochs;
  const base = {
    currentEpoch: context.stack.currentEpoch,
    firstRewardedEpoch: context.stack.effectiveEpoch,
    stakerBudget: context.stakerBudget.toString(),
    explorer: ctx.chain.explorerApiUrl ?? null,
  };
  if (indexer && indexed) {
    try {
      const [sellerEpochs, metrics, own] = await Promise.all([indexer.sellerEpochs(VOLUME_EPOCHS), indexer.epochMetrics(), ownPools(ctx, context)]);
      const views = mergePools({ indexed, explorer: context.explorer, sellerEpochs, epochs, own });
      if (indexed.currentEpoch !== context.stack.currentEpoch) {
        for (const view of views) { view.volumes = []; view.volumeStatus = 'stale'; }
      } else for (const view of views) { view.volumeStatus = view.volumes.length ? 'available' : 'unavailable'; }
      await enrichYields(ctx, context, views, indexed);
      // Staker counts absent from the summary stay unknown. Load detail only when its drawer opens.
      const totalPower = BigInt(indexed.network.current?.totalPowerWeight ?? '0') || context.totalPowerWeight;
      const yourTotalPower = [...own.values()].reduce((sum, entry) => sum + entry.power, 0n);
      return toJson({
        ...base,
        totalActiveStake: indexed.network.current?.totalActiveStake ?? '0',
        totalPowerWeight: totalPower.toString(),
        networkVolumes: metrics.filter(row => epochs.includes(row.epoch)).map((row): EpochVolume => ({ epoch: row.epoch, usdc: row.volumeUsdc })),
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
  return chainOnlyPools(ctx, context, base, indexerError);
}

async function chainOnlyPools(
  ctx: AntsContext,
  context: PoolContext,
  base: Pick<PoolsView, 'currentEpoch' | 'firstRewardedEpoch' | 'stakerBudget' | 'explorer'>,
  sourceError: string | null,
): Promise<PoolsView> {
  const pools = ctx.requirePools();
  const agents: Array<[number, string | null]> = [...context.ownPositions.keys()].map((agentId) => [agentId, null]);
  const views = sortPools(await describePools(ctx, agents, context));
  await enrichYields(ctx, context, views);
  const totalActiveStake = await safe(() => pools.totalActiveStakeAtEpoch(context.stack.currentEpoch), 0n);
  const yourTotalPower = views.reduce((sum, pool) => sum + BigInt(pool.yourPower), 0n);
  return toJson({
    ...base,
    totalActiveStake: totalActiveStake.toString(),
    totalPowerWeight: context.totalPowerWeight.toString(),
    networkVolumes: [],
    yourTotalPower: yourTotalPower.toString(),
    yourNetworkShareBps: bps(yourTotalPower, context.totalPowerWeight),
    source: 'chain',
    sourceError,
    pools: views,
  });
}

/** Optional detail enrichment; never sits on the pool table's initial response path. */
export async function poolStakerCounts(ctx: AntsContext): Promise<Record<string, number | null>> {
  const indexer = ctx.indexer();
  if (!indexer) return {};
  const indexed = await indexer.pools();
  const counts: Record<string, number | null> = {};
  for (let offset = 0; offset < indexed.pools.length; offset += 4) {
    await Promise.all(indexed.pools.slice(offset, offset + 4).map(async pool => {
      if (pool.stakers != null) counts[pool.agentId] = pool.stakers;
      else if (pool.openPositions === 0) counts[pool.agentId] = 0;
      else counts[pool.agentId] = await indexer.pool(pool.agentId, 1).then(detail => detail.stakers).catch(() => null);
    }));
  }
  return counts;
}

export async function singlePool(ctx: AntsContext, agentId: number): Promise<PoolView & { currentEpoch: number }> {
  const context = await poolContext(ctx);
  const indexer = ctx.indexer();
  if (indexer) {
    try {
      const [indexed, sellerEpochs, own] = await Promise.all([indexer.pools(), indexer.sellerEpochs(VOLUME_EPOCHS), ownPools(ctx, context)]);
      const ownHere = new Map([...own.entries()].filter(([id]) => id === agentId));
      const explorer = { byAddress: context.explorer.byAddress, byAgent: new Map([...context.explorer.byAgent.entries()].filter(([id]) => id === agentId)) };
      const merged = mergePools({ indexed: { ...indexed, pools: indexed.pools.filter((pool) => pool.agentId === agentId) }, explorer, sellerEpochs, epochs: context.epochs, own: ownHere });
      const view = merged.find((pool) => pool.agentId === agentId);
      if (view) {
        await enrichYields(ctx, context, [view]);
        const detail = await indexer.pool(agentId, VOLUME_EPOCHS);
        view.stakers = detail.stakers;
        view.volumes = detail.epochs.filter(row => row.epoch < context.stack.currentEpoch).map(row => ({ epoch: row.epoch, usdc: row.volumeUsdc })).sort((a,b) => b.epoch-a.epoch);
        view.volumeStatus = indexed.currentEpoch === context.stack.currentEpoch ? 'available' : 'stale';
        return toJson({ ...view, currentEpoch: context.stack.currentEpoch });
      }
    } catch (error) {
      if (!(error instanceof IndexerError)) throw error;
    }
  }
  const [view] = await describePools(ctx, [[agentId, null]], context);
  if (view) await enrichYields(ctx, context, [view]);
  return toJson({ ...view!, currentEpoch: context.stack.currentEpoch });
}

/** Read historical principal and emission inputs together; failed reads remain unknown. */
async function enrichYields(ctx: AntsContext, context: PoolContext, views: PoolView[], indexed?: IndexedPools): Promise<void> {
  const epoch = context.stack.currentEpoch - 1;
  const batch = new Batch();
  const minLock = batch.add(ctx.chain.sellerPoolsAddress, POOLS_IFACE, 'minStakeEpochs', []);
  const maxLock = batch.add(ctx.chain.sellerPoolsAddress, POOLS_IFACE, 'MAX_STAKE_EPOCHS', []);
  const budget = batch.add(ctx.chain.sellerPoolsRewardsAddress, REWARDS_IFACE, 'stakerEpochBudget', [Math.max(0, epoch)]);
  const totalPoints = batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'totalWeightedPoolPointsByEpoch', [Math.max(0, epoch)]);
  const historical = new Map(indexed?.currentEpoch === context.stack.currentEpoch
    ? indexed.pools.flatMap(p => p.historicalYield ? [[p.agentId, p.historicalYield] as const] : []) : []);
  // The seller directory includes providers without a staking pool. Their yield is
  // unavailable; querying historical contracts for each of them dominates cold loads.
  const candidates = views.filter(view => view.hasPool || view.yourPositionIds.length > 0 || BigInt(historical.get(view.agentId)?.power ?? '0') > 0n);
  const reads = candidates.map(view => ({
    power: historical.has(view.agentId) ? () => [BigInt(historical.get(view.agentId)!.power)] : batch.add(ctx.chain.sellerPoolsAddress, POOLS_IFACE, 'poolWeightAtEpoch', [view.agentId, Math.max(0, epoch)]),
    principal: batch.add(ctx.chain.sellerPoolsAddress, POOLS_IFACE, 'poolActiveStakeAtEpoch', [view.agentId, Math.max(0, epoch)]),
    emission: historical.get(view.agentId)?.settled ? () => [true, BigInt(historical.get(view.agentId)!.reward)] : batch.add(ctx.chain.sellerPoolsRewardsAddress, REWARDS_IFACE, 'poolEpochEmissions', [Math.max(0, epoch), view.agentId]),
    points: batch.add(ctx.chain.usageAccountingAddress, ACCOUNTING_IFACE, 'agentEpochUsage', [Math.max(0, epoch), view.agentId]),
  }));
  await batch.run(ctx);
  candidates.forEach((view, i) => {
    const read = reads[i]!;
    const emission = read.emission(), principal = read.principal()?.[0];
    let reward: bigint | null = emission?.[0] === true && typeof emission[1] === 'bigint' ? emission[1] : null;
    const b = budget()?.[0], total = totalPoints()?.[0];
    const points = (read.points()?.[0] as { weightedPoints?: bigint } | undefined)?.weightedPoints;
    if (reward === null && emission?.[0] === false && typeof b === 'bigint' && typeof total === 'bigint' && typeof points === 'bigint') reward = total > 0n ? b * points / total : 0n;
    view.yield = poolYield(reward, typeof principal === 'bigint' ? principal : null, epoch, context.stack.epochDuration, context.stack.genesis, emission?.[0] === true);
    view.yield.reward = reward?.toString() ?? null;
    view.yield.power = read.power()?.[0]?.toString() ?? null;
    view.yield.minLockEpochs = minLock()?.[0] == null ? null : Number(minLock()![0]);
    view.yield.maxLockEpochs = maxLock()?.[0] == null ? null : Number(maxLock()![0]);
    view.statsUpdatedAt = Date.now();
  });
}
