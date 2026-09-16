import { getAddress, ZeroAddress } from 'ethers';
import type { AntsContext } from './context.js';
import { toJson } from './json.js';

type JsonView<Value> = Value extends bigint ? string : Value extends object ? { [Key in keyof Value]: JsonView<Value[Key]> } : Value;

export function rewardAddress(value: string): string {
  const address = getAddress(value);
  if (address === ZeroAddress) throw new Error('Reward address must not be the zero address.');
  return address;
}

export async function lockedRewards(ctx: AntsContext) {
  const chainId = BigInt(await ctx.provider().send('eth_chainId', []));
  if (chainId !== BigInt(ctx.chain.evmChainId)) throw new Error('RPC chain does not match the configured claim network.');
  const stack = await ctx.stack();
  if (stack.lockedRewardsPoolError) throw new Error(stack.lockedRewardsPoolError);
  const pool = ctx.lockedPoolAt(stack.lockedRewardsPool);
  if (!pool) throw new Error('No legacy seller rewards pool is available on this network.');
  const detail = await pool.details(ctx.address);
  const blockers: string[] = [];
  if (stack.phase !== 'active') blockers.push('M001 is not active.');
  if (ctx.chain.antsTokenAddress && detail.token.toLowerCase() !== ctx.chain.antsTokenAddress.toLowerCase()) blockers.push('The pool uses an unexpected ANTS token contract.');
  if (!detail.transferAllowed) blockers.push('The rewards pool cannot transfer ANTS.');
  if (!detail.policy) {
    blockers.push('No seller claim policy is installed (M002).');
  } else {
    const policy = detail.policy;
    if (!stack.legacyEmissions || policy.legacyEmissions.toLowerCase() !== stack.legacyEmissions.toLowerCase()) blockers.push('The installed policy uses an unexpected legacy emissions contract.');
    if (stack.effectiveEpoch === null || policy.lastEpoch !== BigInt(stack.effectiveEpoch - 1)) blockers.push('The installed policy has an unexpected last legacy epoch.');
    if (policy.cumulativeLocked < detail.locked) blockers.push('Reconstructed cumulative rewards are below the pool balance; accounting review required.');
    if (policy.restricted) blockers.push('The policy wash-trading registry restricts this seller.');
    if (policy.claimable === 0n) blockers.push(detail.locked === 0n ? 'No locked rewards.' : 'No additional rewards are currently released.');
    if (policy.claimable > detail.poolBalance) blockers.push('The pool has insufficient ANTS to pay this claim.');
  }
  const view = { ...detail, chainId: ctx.chain.chainId, evmChainId: ctx.chain.evmChainId, blockers };
  return toJson(view) as unknown as JsonView<typeof view>;
}

export type LockedRewardsView = Awaited<ReturnType<typeof lockedRewards>>;

export async function previewLockedClaim(ctx: AntsContext, recipientAddress = ctx.address) {
  const recipient = rewardAddress(recipientAddress);
  const signer = ctx.requireSigner();
  if (rewardAddress(await signer.getAddress()) !== rewardAddress(ctx.address)) throw new Error('Claim signer does not match the seller address.');
  const view = await lockedRewards(ctx);
  if (view.blockers.length) throw new Error(`Cannot claim locked rewards: ${view.blockers.join(' ')}`);
  const pool = ctx.lockedPoolAt(view.pool)!;
  const network = await pool.provider.getNetwork();
  if (network.chainId !== BigInt(ctx.chain.evmChainId)) throw new Error('RPC chain does not match the configured claim network.');
  if (signer.provider && (await signer.provider.getNetwork()).chainId !== network.chainId) throw new Error('Signer is connected to a different network.');
  const gas = await pool.previewClaim(ctx.address, recipient);
  return { ...view, recipient, gas: toJson(gas) as unknown as JsonView<typeof gas> };
}
