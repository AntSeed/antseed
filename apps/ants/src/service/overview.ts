import type { AntsContext } from './context.js';
import type { OverviewView, EpochInfo } from '../api-types.js';
import { toJson } from './json.js';

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export function epochInfo(stack: { currentEpoch: number; effectiveEpoch: number | null; genesis: number; epochDuration: number }, now = Math.floor(Date.now() / 1000)): EpochInfo {
  const nextBoundaryAt = stack.genesis + (stack.currentEpoch + 1) * stack.epochDuration;
  return {
    current: stack.currentEpoch,
    effective: stack.effectiveEpoch,
    genesis: stack.genesis,
    epochDuration: stack.epochDuration,
    nextBoundaryAt,
    secondsToBoundary: Math.max(0, nextBoundaryAt - now),
  };
}

export async function overview(ctx: AntsContext): Promise<OverviewView> {
  const stack = await ctx.stack();
  const token = ctx.antsToken();
  const pools = ctx.pools();
  const sellerRegistry = ctx.sellerRegistry();
  const legacyStaking = ctx.legacyStakingAt(stack.legacyStaking);

  const [ants, eth, transfersEnabled, whitelisted, totalActiveStake, positionCount, registryAgentId, legacyAgentId, totalSupply, maxSupply] = await Promise.all([
    token.balanceOf(ctx.address),
    token.provider.getBalance(ctx.address),
    safe(() => token.transfersEnabled(), false),
    safe(() => token.transferWhitelist(ctx.address), false),
    pools ? safe(() => pools.stakerTotalActiveStake(ctx.address), 0n) : Promise.resolve(0n),
    pools ? safe(() => pools.stakerPositionCount(ctx.address), 0) : Promise.resolve(0),
    sellerRegistry ? safe(() => sellerRegistry.getAgentId(ctx.address), 0) : Promise.resolve(0),
    legacyStaking ? safe(() => legacyStaking.getAgentId(ctx.address), 0) : Promise.resolve(0),
    safe(() => token.totalSupply(), 0n),
    safe(() => token.maxSupply(), 0n),
  ]);

  let network: OverviewView['network'] = null;
  if (pools) {
    const gate = ctx.gate();
    const poolRewards = ctx.poolRewards();
    const usageRewards = ctx.usageRewards();
    const epoch = stack.currentEpoch;
    const [networkStake, networkWeight, epochEmission, stakerBudget, usageBudgets] = await Promise.all([
      safe(() => pools.totalActiveStakeAtEpoch(epoch), 0n),
      safe(() => pools.totalPowerWeightAtEpoch(epoch), 0n),
      gate ? safe(() => gate.getEpochEmission(epoch), 0n) : Promise.resolve(0n),
      poolRewards ? safe(() => poolRewards.stakerEpochBudget(epoch), 0n) : Promise.resolve(0n),
      usageRewards ? safe(() => usageRewards.usageEpochBudgets(epoch), { buyer: 0n, seller: 0n }) : Promise.resolve({ buyer: 0n, seller: 0n }),
    ]);
    network = {
      totalActiveStake: networkStake.toString(),
      totalPowerWeight: networkWeight.toString(),
      epochEmission: epochEmission.toString(),
      stakerBudget: stakerBudget.toString(),
      usageBuyerBudget: usageBudgets.buyer.toString(),
      usageSellerBudget: usageBudgets.seller.toString(),
      antsTotalSupply: totalSupply.toString(),
      antsMaxSupply: maxSupply.toString(),
    };
  }

  const notices: string[] = [];
  const epoch = epochInfo(stack);
  if (stack.phase === 'legacy') {
    notices.push('The recognized-usage contracts are not configured for this chain. Only legacy emissions are available.');
  } else if (stack.phase === 'deployed') {
    const startsAt = stack.effectiveEpoch !== null ? new Date((stack.genesis + stack.effectiveEpoch * stack.epochDuration) * 1000).toUTCString() : 'the cutover';
    notices.push(`Recognized usage is deployed but not active yet: the registry still points at the legacy stack. Rewards from epoch ${stack.effectiveEpoch ?? '?'} start at ${startsAt}. Positions staked now have power from the first rewarded epoch.`);
  }
  if (!transfersEnabled && !whitelisted) {
    notices.push('ANTS transfers are not enabled and this wallet is not whitelisted, so staking new ANTS is not possible yet. Rewards can still be claimed and restaked.');
  }

  return toJson({
    phase: stack.phase,
    chainId: ctx.chain.chainId,
    evmChainId: ctx.chain.evmChainId,
    rpcUrl: ctx.chain.rpcUrl,
    addresses: ctx.addresses(),
    epoch,
    wallet: {
      address: ctx.address,
      ants: ants.toString(),
      eth: eth.toString(),
      transfersEnabled,
      whitelisted,
      canTransfer: transfersEnabled || whitelisted,
      totalActiveStake: totalActiveStake.toString(),
      positionCount,
      agentId: registryAgentId || legacyAgentId,
      sellerBound: registryAgentId !== 0,
    },
    network,
    notices,
  });
}
