import { Interface, ZeroAddress } from 'ethers';
import { multicallRead, type MulticallRequest } from '@antseed/node/payments';
import type { AntsContext, ResolvedStack } from './context.js';
import { displayData } from './display-snapshot.js';

const ABI = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfersEnabled() view returns (bool)',
  'function transferWhitelist(address) view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function stakerTotalActiveStake(address) view returns (uint256)',
  'function stakerPositionCount(address) view returns (uint256)',
  'function getAgentId(address) view returns (uint256)',
  'function totalActiveStakeAtEpoch(uint256) view returns (uint256)',
  'function totalPowerWeightAtEpoch(uint256) view returns (uint256)',
  'function getEpochEmission(uint256) view returns (uint256)',
  'function stakerEpochBudget(uint256) view returns (uint256)',
  'function usageEpochBudgets(uint256) view returns (uint256 buyer, uint256 seller)',
]);

/** One Multicall for overview contract state; missing configured reads must not become zero balances. */
export async function overviewReads(ctx: AntsContext, stack: ResolvedStack) {
  const display = await displayData(ctx, stack);
  const network = display.snapshot?.epochs.find(row => row.epoch === stack.currentEpoch);
  const requests: MulticallRequest[] = [];
  const add = (target: string | undefined | null, method: string, args: unknown[] = []) => {
    if (!target || target.toLowerCase() === ZeroAddress) return -1;
    return requests.push({ target, iface: ABI, method, args }) - 1;
  };
  const c = ctx.chain, address = ctx.address, epoch = stack.currentEpoch;
  const token = ctx.antsToken().contractAddress;
  const ids = {
    ants: add(token, 'balanceOf', [address]), transfers: add(token, 'transfersEnabled'), whitelist: add(token, 'transferWhitelist', [address]),
    supply: add(token, 'totalSupply'), maxSupply: add(token, 'MAX_SUPPLY'),
    stake: add(c.sellerPoolsAddress, 'stakerTotalActiveStake', [address]), count: add(c.sellerPoolsAddress, 'stakerPositionCount', [address]),
    agent: add(c.sellerRegistryAddress, 'getAgentId', [address]), legacyAgent: add(stack.legacyStaking, 'getAgentId', [address]),
    networkStake: network ? -1 : add(c.sellerPoolsAddress, 'totalActiveStakeAtEpoch', [epoch]), networkWeight: network ? -1 : add(c.sellerPoolsAddress, 'totalPowerWeightAtEpoch', [epoch]),
    emission: add(c.emissionsGateAddress, 'getEpochEmission', [epoch]), budget: network ? -1 : add(c.sellerPoolsRewardsAddress, 'stakerEpochBudget', [epoch]),
    usage: add(c.usageRewardsAddress, 'usageEpochBudgets', [epoch]),
  };
  const [values, eth] = await Promise.all([multicallRead(ctx.provider(), requests), ctx.provider().getBalance(address)]);
  const read = (index: number, field = 0): unknown => {
    if (index < 0) return 0n;
    const value = values[index]?.[field];
    if (value === undefined) throw new Error(`Wallet overview read failed: ${requests[index]!.method}. Retry when the RPC is available.`);
    return value;
  };
  const big = (index: number, field = 0) => BigInt(read(index, field) as bigint);
  return {
    ants: big(ids.ants), eth, transfersEnabled: read(ids.transfers) === true, whitelisted: read(ids.whitelist) === true,
    totalActiveStake: big(ids.stake), positionCount: Number(big(ids.count)), registryAgentId: Number(big(ids.agent)), legacyAgentId: Number(big(ids.legacyAgent)),
    totalSupply: big(ids.supply), maxSupply: big(ids.maxSupply), networkStake: network ? BigInt(network.totalActiveStake) : big(ids.networkStake), networkWeight: network ? BigInt(network.totalPowerWeight) : big(ids.networkWeight),
    epochEmission: big(ids.emission), stakerBudget: network ? BigInt(network.stakerBudget) : big(ids.budget), usageBudgets: { buyer: big(ids.usage), seller: big(ids.usage, 1) },
    networkSource: display.source,
  };
}
