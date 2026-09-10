import { GATE_MINTERS, gateMinterId } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import type { EmissionsView, MinterView } from '../api-types.js';
import { toJson } from './json.js';

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); } catch { return fallback; }
}

export async function emissions(ctx: AntsContext): Promise<EmissionsView> {
  const stack = await ctx.stack();
  const gate = ctx.gate();
  const legacy = ctx.legacyEmissionsAt(stack.legacyEmissions);
  const poolRewards = ctx.poolRewards();
  const usageRewards = ctx.usageRewards();

  let view: Omit<EmissionsView, 'legacy' | 'dynamicStaker' | 'dynamicUsage'>;
  if (gate) {
    const epoch = stack.currentEpoch;
    const [halvingInterval, initialEmission, currentRate, cumulative, shareDenominator, emissionsReserve, legacyEscrow] = await Promise.all([
      gate.halvingInterval(), gate.initialEmission(), gate.currentEmissionRate(), safe(() => gate.cumulativeEmissionThrough(epoch + 1), 0n),
      safe(() => gate.shareDenominator(), 100_000), safe<string | null>(() => gate.emissionsReserve(), null), safe<string | null>(() => gate.legacyEscrow(), null),
    ]);
    const minters: MinterView[] = await Promise.all(GATE_MINTERS.map(async (minter) => {
      const id = gateMinterId(minter.id);
      const [info, budget] = await Promise.all([
        safe(() => gate.minter(id), { controller: '0x0000000000000000000000000000000000000000', shareBps: 0, editable: false }),
        safe(() => gate.minterEpochBudget(id, Math.max(epoch, stack.effectiveEpoch ?? epoch)), 0n),
      ]);
      return { name: minter.name, id, controller: info.controller, shareBps: info.shareBps, editable: info.editable, epochBudget: budget.toString() };
    }));
    view = {
      currentEpoch: epoch, effectiveEpoch: stack.effectiveEpoch, genesis: stack.genesis, epochDuration: stack.epochDuration, halvingInterval,
      initialEmission: initialEmission.toString(), currentRate: currentRate.toString(), cumulativeThroughCurrent: cumulative.toString(),
      shareDenominator, minters, emissionsReserve, legacyEscrow,
    };
  } else {
    if (!legacy) throw new Error('No emissions contract configured.');
    const [halvingInterval, initialEmission, info] = await Promise.all([legacy.getHalvingInterval(), safe(() => legacy.getEpochEmission(0), 0n), legacy.getEpochInfo()]);
    view = {
      currentEpoch: stack.currentEpoch, effectiveEpoch: null, genesis: stack.genesis, epochDuration: stack.epochDuration, halvingInterval,
      initialEmission: initialEmission.toString(), currentRate: info.emission.toString(), cumulativeThroughCurrent: '0', shareDenominator: 100, minters: [],
      emissionsReserve: null, legacyEscrow: null,
    };
  }

  const dynamicStaker = poolRewards ? await safe<EmissionsView['dynamicStaker']>(async () => {
    const config = await poolRewards.dynamicStakerConfigAt(stack.currentEpoch);
    return { minShareBps: config.minShareBps, maxShareBps: config.maxShareBps, stakeShareTarget: config.stakeShareTarget.toString() };
  }, null) : null;
  const dynamicUsage = usageRewards ? await safe<EmissionsView['dynamicUsage']>(async () => {
    const config = await usageRewards.dynamicUsageConfigAt(stack.currentEpoch);
    return { ...config, volumeShareTarget: config.volumeShareTarget.toString() };
  }, null) : null;
  const legacyView = legacy && stack.legacyEmissions ? await safe<EmissionsView['legacy']>(async () => {
    const [shares, info] = await Promise.all([legacy.getShares(), legacy.getEpochInfo()]);
    return { contract: stack.legacyEmissions!, sellerPct: shares.sellerSharePct, buyerPct: shares.buyerSharePct, reservePct: shares.reserveSharePct, teamPct: shares.teamSharePct, currentEpoch: info.epoch };
  }, null) : null;

  return toJson({ ...view, dynamicStaker, dynamicUsage, legacy: legacyView });
}
