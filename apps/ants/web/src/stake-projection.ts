import type { PoolYield } from '../../src/api-types';

export const REFERENCE_STAKE = 1000n * 10n ** 18n;
const DAY = 86400;

/** Nearest whole-epoch lock; unsupported presets stay unavailable rather than mislabelled. */
export function presetEpochs(days: number, duration: number, min: number | null | undefined, max: number | null | undefined): number | null {
  if (!Number.isFinite(duration) || duration <= 0 || min == null || max == null) return null;
  const epochs = Math.max(1, Math.round(days * DAY / duration));
  return epochs >= min && epochs <= max ? epochs : null;
}

export function projectStake(yieldInfo: PoolYield | undefined, amount: bigint | null, epochs: number | null) {
  if (!yieldInfo || yieldInfo.status === 'unavailable' || yieldInfo.epoch < 0 || amount === null || amount <= 0n ||
      epochs === null || !Number.isSafeInteger(epochs) || epochs < 1 ||
      yieldInfo.minLockEpochs == null || yieldInfo.maxLockEpochs == null ||
      epochs < yieldInfo.minLockEpochs || epochs > yieldInfo.maxLockEpochs ||
      yieldInfo.reward == null || yieldInfo.power == null) return null;
  const duration = yieldInfo.endsAt - yieldInfo.startsAt;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  try {
    const reward = BigInt(yieldInfo.reward), poolPower = BigInt(yieldInfo.power);
    // No historical active power means there is no usable pool baseline.
    if (reward < 0n || poolPower <= 0n) return null;
    const power = amount * BigInt(epochs);
    const epochReward = reward * power / (poolPower + power);
    const rate = Number(epochReward * 10n ** 18n / amount) / 1e18;
    const periods = 365 * DAY / duration;
    const apr = rate * periods * 100;
    const apy = Math.expm1(Math.log1p(rate) * periods) * 100;
    return { power, epochReward, apr: Number.isFinite(apr) ? apr : null, apy: Number.isFinite(apy) ? apy : null };
  } catch { return null; }
}

export function referenceProjection(info: PoolYield | undefined, days: number) {
  const epochs = info ? presetEpochs(days, info.endsAt - info.startsAt, info.minLockEpochs, info.maxLockEpochs) : null;
  return { epochs, projection: projectStake(info, REFERENCE_STAKE, epochs) };
}

export const YIELD_DISPLAY_LIMIT = 10_000;
export const EXTREME_YIELD_NOTE = 'This projection exceeds the 10,000.00% display limit. Annual compounding magnifies unusually high epoch returns; this is not a guaranteed return.';

export function formatProjectionPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const shown = Math.min(value, YIELD_DISPLAY_LIMIT);
  return `${value > YIELD_DISPLAY_LIMIT ? '>' : ''}${shown.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export const PROJECTION_ASSUMPTIONS = 'Projects the initial earning rate using last epoch’s pool rewards and power, including your added power. Assumes the pool reward budget stays unchanged. Normal position power decreases as the lock runs down; other stakes and activity can change. APY assumes repeated compounding, which is not automatic or guaranteed. Activation delay is excluded.';
