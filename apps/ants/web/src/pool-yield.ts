import type { PoolYield } from '../../src/api-types';

const REFERENCE_STAKE = 10000n * 10n ** 18n;
const DAY = 86400;

export const YIELD_DISPLAY_LIMIT = 10_000;
export const EXTREME_YIELD_LABEL = '>10.000%';
export const EXTREME_YIELD_NOTE = `APY is shown as ${EXTREME_YIELD_LABEL} when either end of the range exceeds 10,000%. Ranges at or below 10,000% remain visible.`;

export function formatYieldPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value > YIELD_DISPLAY_LIMIT) return EXTREME_YIELD_LABEL;
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function lockPeriod(info: PoolYield | undefined, days: number): { epochs: number | null; actualDays: number | null; status: 'supported' | 'unsupported' | 'unavailable' } {
  const duration = info ? info.endsAt - info.startsAt : 0;
  if (!info || !Number.isFinite(duration) || duration <= 0 || info.minLockEpochs == null || info.maxLockEpochs == null) {
    return { epochs: null, actualDays: null, status: 'unavailable' };
  }
  const epochs = Math.round(days * DAY / duration);
  if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs < info.minLockEpochs || epochs > info.maxLockEpochs) {
    return { epochs: null, actualDays: null, status: 'unsupported' };
  }
  return { epochs, actualDays: epochs * duration / DAY, status: 'supported' };
}

function lockApy(info: PoolYield | undefined, days: number): { epochs: number | null; apy: number | null } {
  const unavailable = { epochs: null, apy: null };
  if (!info || info.status === 'unavailable' || info.epoch < 0 || info.reward == null || info.power == null ||
      info.minLockEpochs == null || info.maxLockEpochs == null) return unavailable;
  const duration = info.endsAt - info.startsAt;
  if (!Number.isFinite(duration) || duration <= 0) return unavailable;
  const { epochs } = lockPeriod(info, days);
  if (epochs === null) return unavailable;
  try {
    const reward = BigInt(info.reward);
    const poolPower = BigInt(info.power);
    if (reward < 0n || poolPower <= 0n) return unavailable;
    const stakePower = REFERENCE_STAKE * BigInt(epochs);
    const epochReward = reward * stakePower / (poolPower + stakePower);
    const rate = Number(epochReward * 10n ** 18n / REFERENCE_STAKE) / 1e18;
    const apy = Math.expm1(Math.log1p(rate) * (365 * DAY / duration)) * 100;
    return { epochs, apy: Number.isFinite(apy) ? apy : null };
  } catch {
    return unavailable;
  }
}

export function poolApyRange(info: PoolYield | undefined) {
  return { oneWeek: lockApy(info, 7), twoYears: lockApy(info, 730) };
}

export function poolApyEstimates(info: PoolYield | undefined) {
  return [
    { label: '1 day', days: 1 }, { label: '1 month', days: 30 },
    { label: '1 year', days: 365 }, { label: '2 years', days: 730 },
  ].map(period => ({ ...period, ...lockPeriod(info, period.days), apy: lockApy(info, period.days).apy }));
}
