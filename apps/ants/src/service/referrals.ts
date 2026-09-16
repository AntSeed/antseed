import type { ReferralView } from '../api-types.js';
import type { AntsContext } from './context.js';
import { silentReporter, type StepReporter } from './steps.js';

export async function referral(ctx: AntsContext): Promise<ReferralView> {
  const client = ctx.referrals();
  if (!client) return { available: false, referralUrl: null, claimable: '0', rateBps: 200 };
  const [amount, rateBps] = await Promise.all([
    client.claimable(ctx.address),
    client.referralRateBps(),
  ]);
  return {
    available: true,
    referralUrl: `https://antseed.com/?ref=${encodeURIComponent(ctx.address)}`,
    claimable: amount.toString(),
    rateBps,
  };
}

export async function claimReferralRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const amount = await client.claimable(ctx.address);
  if (amount === 0n) throw new Error('No referral rewards to claim.');
  await report('Claiming referral rewards');
  const hash = await client.claim(ctx.requireSigner());
  await report('Referral rewards claimed', hash);
  return { hash };
}
