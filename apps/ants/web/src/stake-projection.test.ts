import { describe, expect, it } from 'vitest';
import type { PoolYield } from '../../src/api-types';
import { formatProjectionPercent, presetEpochs, projectStake, referenceProjection, REFERENCE_STAKE } from './stake-projection';
const unit = 10n ** 18n;
const history: PoolYield = { epoch: 20, startsAt: 0, endsAt: 604800, status: 'settled', apr: 0, apy: 0,
  reward: (100n * unit).toString(), power: (10000n * unit).toString(), minLockEpochs: 1, maxLockEpochs: 104 };

describe('new stake projections', () => {
  it('uses historical pool power plus the new position, with fixed historical rewards', () => {
    const result = projectStake(history, 1000n * unit, 10)!;
    expect(result.power).toBe(10000n * unit);
    expect(result.epochReward).toBe(50n * unit);
    expect(result.apr).toBeCloseTo(0.05 * 365 / 7 * 100);
    expect(result.apy).toBeCloseTo((1.05 ** (365 / 7) - 1) * 100);
  });
  it('updates with amount and lock length, accounts for dilution, and caps rewards below pool budget', () => {
    const small = projectStake(history, unit, 4)!;
    const large = projectStake(history, 1000000n * unit, 4)!;
    expect(large.epochReward).toBeLessThan(100n * unit);
    expect(large.apy!).toBeLessThan(small.apy!);
    expect(projectStake(history, unit, 52)!.apy!).toBeGreaterThan(small.apy!);
    expect(referenceProjection(history, 30).projection).toEqual(projectStake(history, REFERENCE_STAKE, 4));
  });
  it('uses chain epoch duration and respects supported lock limits', () => {
    expect(presetEpochs(30, 604800, 1, 104)).toBe(4);
    expect(presetEpochs(365, 604800, 1, 104)).toBe(52);
    expect(presetEpochs(30, 86400, 1, 104)).toBe(30);
    expect(presetEpochs(365, 86400, 1, 104)).toBeNull();
    expect(presetEpochs(30, 604800, 6, 104)).toBeNull();
    const daily = projectStake({ ...history, endsAt: 86400 }, 1000n * unit, 10)!;
    expect(daily.apr).toBeCloseTo(0.05 * 365 * 100);
  });
  it('distinguishes confirmed zero from missing data and handles invalid input', () => {
    expect(projectStake({ ...history, reward: '0' }, unit, 4)?.apy).toBe(0);
    expect(projectStake({ ...history, status: 'estimated' }, unit, 4)).not.toBeNull();
    for (const change of [{ reward: null }, { power: null }, { power: '0' }, { reward: '-1' }, { power: 'bad' }, { status: 'unavailable' as const }, { epoch: -1 }, { endsAt: 0 }, { minLockEpochs: null }]) {
      expect(projectStake({ ...history, ...change }, unit, 4)).toBeNull();
    }
    for (const amount of [null, 0n, -unit]) expect(projectStake(history, amount, 4)).toBeNull();
    for (const lock of [null, 0, 105, 1.5]) expect(projectStake(history, unit, lock)).toBeNull();
    expect(projectStake({ ...history, reward: (10n ** 100n).toString() }, unit, 4)?.apy).toBeNull();
  });
});


describe('percentage display', () => {
  it('always displays two decimal places without scientific notation', () => {
    for (const value of [0, 1, 12.3456, 9999.99, 10000]) {
      const expected = new Intl.NumberFormat(undefined, {notation: 'standard', minimumFractionDigits: 2, maximumFractionDigits: 2}).format(value) + '%';
      expect(formatProjectionPercent(value)).toBe(expected);
      expect(formatProjectionPercent(value)).not.toMatch(/e[+-]/i);
    }
  });
  it('bounds extreme yields without changing their underlying calculations', () => {
    for (const value of [10000.01, 1e6, 5.78e35]) expect(formatProjectionPercent(value)).toBe('>' + formatProjectionPercent(10000));
  });
  it('keeps unavailable and non-finite yields distinct from zero', () => {
    for (const value of [null, undefined, Infinity, NaN]) expect(formatProjectionPercent(value)).toBe('—');
  });
});
