import { ZeroAddress } from 'ethers';
import type { AntsContext } from './context.js';
import type { SellerView } from '../api-types.js';
import { formatAnts } from './format.js';
import { toJson } from './json.js';
import { silentReporter, type StepReporter } from './steps.js';

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); } catch { return fallback; }
}

export async function seller(ctx: AntsContext): Promise<SellerView> {
  const stack = await ctx.stack();
  const identity = ctx.identity();
  const registry = ctx.sellerRegistry();
  const legacyStaking = ctx.legacyStakingAt(stack.legacyStaking);
  const pools = ctx.pools();
  const init = ctx.positionInit();

  const [identityRegistered, registryAgentId, legacyAgentId, legacyStake, legacyEligible, registryEligible, legacyEligibilityEnabled, minPoolStake] = await Promise.all([
    identity ? safe(() => identity.isRegistered(ctx.address), false) : Promise.resolve(false),
    registry ? safe(() => registry.getAgentId(ctx.address), 0) : Promise.resolve(0),
    legacyStaking ? safe(() => legacyStaking.getAgentId(ctx.address), 0) : Promise.resolve(0),
    legacyStaking ? safe(() => legacyStaking.getStake(ctx.address), 0n) : Promise.resolve(0n),
    legacyStaking ? safe(() => legacyStaking.isStakedAboveMin(ctx.address), false) : Promise.resolve(false),
    registry ? safe(() => registry.isStakedAboveMin(ctx.address), false) : Promise.resolve(false),
    registry ? safe<boolean | null>(() => registry.legacyStakeEligibilityEnabled(), null) : Promise.resolve(null),
    registry ? safe<bigint | null>(() => registry.minSellerPoolStake(), null) : Promise.resolve(null),
  ]);
  const agentId = registryAgentId || legacyAgentId;
  const poolActiveStake = pools && agentId ? await safe(() => pools.poolActiveStakeAtEpoch(agentId, stack.currentEpoch), 0n) : 0n;

  let starter: SellerView['starter'] = null;
  if (init && pools) {
    const [initialized, remaining, amount, endEpoch, activationDelay] = await Promise.all([
      agentId ? safe(() => init.agentInitialized(agentId), false) : Promise.resolve(false),
      safe(() => init.remainingInits(), 0n), safe(() => init.initAmount(), 0n), safe(() => init.initEndEpoch(), 0), safe(() => pools.stakeActivationDelay(), 1),
    ]);
    const legacyStarterEligible = legacyAgentId !== 0 && legacyEligible;
    const expired = stack.currentEpoch + activationDelay >= endEpoch;
    starter = {
      contract: init.contractAddress, initialized, remaining: remaining.toString(), amount: amount.toString(), endEpoch,
      legacyEligible: legacyStarterEligible, expired, claimable: legacyStarterEligible && !initialized && !expired && remaining > 0n,
    };
  }

  return toJson({
    address: ctx.address,
    agentId,
    identityRegistered,
    registryBound: registryAgentId !== 0,
    eligible: stack.phase === 'active' ? registryEligible : legacyEligible,
    legacyStake: legacyStake.toString(),
    legacyEligibilityEnabled,
    minPoolStake: minPoolStake === null ? null : minPoolStake.toString(),
    poolActiveStake: poolActiveStake.toString(),
    starter,
  });
}

export async function registerBinding(ctx: AntsContext, agentIdInput?: number, report: StepReporter = silentReporter): Promise<{ agentId: number; sent: boolean }> {
  const signer = ctx.requireSigner();
  const registry = ctx.sellerRegistry();
  if (!registry) throw new Error('Seller registry is not configured; use `antseed seller register` on this chain.');
  const stack = await ctx.stack();
  const legacyStaking = ctx.legacyStakingAt(stack.legacyStaking);
  const agentId = agentIdInput ?? (legacyStaking ? await safe(() => legacyStaking.getAgentId(ctx.address), 0) : 0);
  if (!agentId) throw new Error('No agent ID known for this wallet. Register an identity first with `antseed seller register`.');
  const identity = ctx.identity();
  if (identity) {
    const owner = await safe(() => identity.getAgentWallet(agentId), ZeroAddress);
    if (owner.toLowerCase() !== ctx.address.toLowerCase()) throw new Error(`Agent ${agentId} is owned by ${owner}, not this wallet.`);
  }
  await report(`Binding agent ${agentId} to ${ctx.address} in the seller registry`);
  let sent = false;
  await registry.registerSellerBinding(signer, agentId, async (hash) => { sent = true; await report('Registration confirmed', hash); });
  if (!sent) await report('Registration already complete; nothing sent');
  ctx.invalidate();
  return { agentId, sent };
}

export async function claimStarter(ctx: AntsContext, report: StepReporter = silentReporter): Promise<{ hash: string; agentId: number; amount: string; endEpoch: number }> {
  const signer = ctx.requireSigner();
  const init = ctx.positionInit();
  if (!init) throw new Error('Starter positions are not configured for this chain.');
  const view = await seller(ctx);
  if (!view.starter) throw new Error('Starter positions are unavailable.');
  if (view.starter.initialized) throw new Error(`Starter position already initialized for agent ${view.agentId}.`);
  if (!view.starter.legacyEligible) throw new Error('Starter grants require a legacy USDC stake at or above the minimum bound to this wallet.');
  if (view.starter.expired) throw new Error(`Starter initialization closed at epoch ${view.starter.endEpoch}.`);
  if (BigInt(view.starter.remaining) === 0n) throw new Error('The starter faucet is depleted.');
  await report(`Creating ${formatAnts(view.starter.amount)} ANTS starter position for agent ${view.agentId} (locked through epoch ${view.starter.endEpoch})`);
  const hash = await init.initPosition(signer);
  await report('Starter position created', hash);
  ctx.invalidate();
  return { hash, agentId: view.agentId, amount: view.starter.amount, endEpoch: view.starter.endEpoch };
}
