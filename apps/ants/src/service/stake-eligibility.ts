import { Interface, isAddress, ZeroAddress } from 'ethers';
import { multicallRead } from '@antseed/node/payments/browser';
import type { AntsContext } from './context.js';

const ABI = new Interface([
  'function identityRegistry() view returns (address)',
  'function stakingSource() view returns (address)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentId(address owner) view returns (uint256)',
]);

export interface StakeEligibility {
  owner: string | null;
  stakeable: boolean;
}

function requiredAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === ZeroAddress) {
    throw new Error(`Unable to verify staking eligibility: ${field} is unavailable. Retry when the RPC is available.`);
  }
  return value.toLowerCase();
}

export async function stakeEligibility(ctx: AntsContext, agentIds: number[]): Promise<Map<number, StakeEligibility>> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return new Map();
  const pools = ctx.requirePools();
  const blockTag = await pools.provider.getBlockNumber();
  const pointers = await multicallRead(pools.provider, ['identityRegistry', 'stakingSource'].map(method => ({
    target: pools.contractAddress, iface: ABI, method,
  })), { blockTag });
  const identity = requiredAddress(pointers[0]?.[0], 'identity registry');
  const source = requiredAddress(pointers[1]?.[0], 'staking source');
  const owners = await multicallRead(pools.provider, ids.map(agentId => ({
    target: identity, iface: ABI, method: 'ownerOf', args: [agentId],
  })), { blockTag });
  const byAgent = new Map(ids.map((agentId, index) => {
    const value = owners[index]?.[0];
    const owner = value == null || value === ZeroAddress ? null : requiredAddress(value, `owner of agent ${agentId}`);
    return [agentId, owner] as const;
  }));
  const uniqueOwners = [...new Set([...byAgent.values()].filter((owner): owner is string => owner !== null))];
  const registrations = await multicallRead(pools.provider, uniqueOwners.map(owner => ({
    target: source, iface: ABI, method: 'getAgentId', args: [owner],
  })), { blockTag });
  const registered = new Map(uniqueOwners.map((owner, index) => {
    const agentId = registrations[index]?.[0];
    if (typeof agentId !== 'bigint') {
      throw new Error('Unable to verify staking eligibility: seller registration is unavailable. Retry when the RPC is available.');
    }
    return [owner, agentId] as const;
  }));
  return new Map(ids.map(agentId => {
    const owner = byAgent.get(agentId)!;
    return [agentId, { owner, stakeable: owner !== null && registered.get(owner) === BigInt(agentId) }];
  }));
}
