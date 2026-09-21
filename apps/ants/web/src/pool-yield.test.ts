import { describe, expect, it } from 'vitest';
import type { PoolYield } from '../../src/api-types';
import { formatYieldPercent, poolApyRange, poolApyEstimates } from './pool-yield';

const unit = 10n ** 18n;
const history: PoolYield = {
  epoch: 20, startsAt: 0, endsAt: 604800, status: 'settled', apr: 0, apy: 0,
  reward: (100n * unit).toString(), power: (10000n * unit).toString(), minLockEpochs: 1, maxLockEpochs: 104,
};

describe('pool APY lock range', () => {
  it('shows four requested lock durations without inventing a one-day weekly lock', () => {
    const periods = poolApyEstimates(history);
    expect(periods.map(period => period.label)).toEqual(['1 day', '1 month', '1 year', '2 years']);
    expect(periods.map(period => period.epochs)).toEqual([null, 4, 52, 104]);
    expect(periods.map(period => period.actualDays)).toEqual([null, 28, 364, 728]);
    expect(periods[0]).toMatchObject({ status: 'unsupported', apy: null });
    expect(periods[1]!.apy).toBeCloseTo(((1 + 100 * 4 / 50000) ** (365 / 7) - 1) * 100);
    expect(periods[2]!.apy).toBeCloseTo(((1 + 100 * 52 / 530000) ** (365 / 7) - 1) * 100);
    expect(periods[3]!.apy).toEqual(poolApyRange(history).twoYears.apy);
  });

  it('supports a one-day estimate when epochs and pool limits actually allow it', () => {
    const periods = poolApyEstimates({ ...history, endsAt: 86400, maxLockEpochs: 730 });
    expect(periods.map(period => period.epochs)).toEqual([1, 30, 365, 730]);
    expect(periods[0]!.apy).toBeCloseTo(((1 + 100 / 20000) ** 365 - 1) * 100);
    expect(periods.every(period => period.status === 'supported')).toBe(true);
  });

  it('distinguishes missing APY inputs from unsupported lock durations', () => {
    expect(poolApyEstimates(undefined).every(period => period.status === 'unavailable' && period.apy === null)).toBe(true);
    expect(poolApyEstimates({ ...history, maxLockEpochs: 52 })[3]).toMatchObject({ status: 'unsupported', apy: null });
    expect(poolApyEstimates({ ...history, reward: null })[1]).toMatchObject({ status: 'supported', epochs: 4, apy: null });
    expect(poolApyEstimates({ ...history, reward: '0' })[1]!.apy).toBe(0);
  });
  it('calculates one-week and two-year initial rates with 10,000 ANTS added to pool power', () => {
    const range = poolApyRange(history);
    expect(range.oneWeek.epochs).toBe(1);
    expect(range.twoYears.epochs).toBe(104);
    expect(range.oneWeek.apy).toBeCloseTo(((1 + 100 / 20000) ** (365 / 7) - 1) * 100);
    expect(range.twoYears.apy).toBeCloseTo(((1 + 100 * 104 / 1050000) ** (365 / 7) - 1) * 100);
    expect(range.twoYears.apy!).toBeGreaterThan(range.oneWeek.apy!);
  });

  it('uses configured epoch duration and leaves unsupported endpoints unavailable', () => {
    expect(poolApyRange({ ...history, minLockEpochs: 2 }).oneWeek.apy).toBeNull();
    expect(poolApyRange({ ...history, minLockEpochs: 2 }).twoYears.apy).not.toBeNull();
    expect(poolApyRange({ ...history, maxLockEpochs: 52 }).twoYears.apy).toBeNull();
    const daily = poolApyRange({ ...history, endsAt: 86400, maxLockEpochs: 730 });
    expect(daily.oneWeek.epochs).toBe(7);
    expect(daily.twoYears.epochs).toBe(730);
    expect(daily.oneWeek.apy).toBeCloseTo(((1 + 100 * 7 / 80000) ** 365 - 1) * 100);
  });

  it('keeps zero rewards, estimates and missing history distinct', () => {
    expect(poolApyRange({ ...history, reward: '0' })).toEqual({ oneWeek: { epochs: 1, apy: 0 }, twoYears: { epochs: 104, apy: 0 } });
    expect(poolApyRange({ ...history, status: 'estimated' })).toEqual(poolApyRange(history));
    for (const change of [{ reward: null }, { power: null }, { power: '0' }, { reward: '-1' }, { power: 'bad' }, { status: 'unavailable' as const }, { epoch: -1 }, { endsAt: 0 }, { minLockEpochs: null }, { maxLockEpochs: null }]) {
      const range = poolApyRange({ ...history, ...change });
      expect(range.oneWeek.apy).toBeNull();
      expect(range.twoYears.apy).toBeNull();
    }
    expect(poolApyRange(undefined).oneWeek.apy).toBeNull();
    const extreme = poolApyRange({ ...history, reward: (10n ** 100n).toString() });
    expect(extreme.oneWeek.apy).toBeNull();
    expect(extreme.twoYears.apy).toBeNull();
  });
});

describe('pool yield display', () => {
  it('displays two decimal places without scientific notation', () => {
    for (const value of [0, 1, 5.3456, 10, 10.01, 100, 9999.9999, 10000]) {
      const expected = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + '%';
      expect(formatYieldPercent(value)).toBe(expected);
      expect(formatYieldPercent(value)).not.toMatch(/e[+-]/i);
    }
  });

  it('shows >10.000% strictly above 10,000%, before rounding, without changing calculations', () => {
    expect(formatYieldPercent(10000)).toBe('10,000.00%');
    for (const value of [10000.000001, 10000.01, 10001, 1e6, 5.78e35]) expect(formatYieldPercent(value)).toBe('>10.000%');
    expect(poolApyRange(history).oneWeek.apy).toBeGreaterThan(10);
  });

  it('keeps unavailable and non-finite yields distinct from zero', () => {
    for (const value of [null, undefined, Infinity, NaN]) expect(formatYieldPercent(value)).toBe('—');
    expect(formatYieldPercent(0)).toBe('0.00%');
  });
});
