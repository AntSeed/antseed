import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { getRoutingSavingsDashboardHtml } from '../src/routing/routing-savings-dashboard.js';

const html = getRoutingSavingsDashboardHtml();
const script = html.split('<script>')[1]!.split('  Promise.all([')[0]!;
const dashboard = runInNewContext(`${script}\nreturn { computeSavings, computeOpenRouterSavings, fmtUsd, statsRowHtml }; })();`);
const price = { inUsdPerM: 10, outUsdPerM: 20, cachedInUsdPerM: 0 };
const row = { actualModel: 'fixture-model', actualPromptTokens: 100, actualCachedTokens: 50,
  actualCompletionTokens: 20, actualUsdcPaid: 0.0001, baselinePrices: { baseline: price } };

describe('embedded savings dashboard', () => {
  it('labels the bounded ledger as retained history, not all-time savings', () => {
    expect(html).toContain('Saved, retained history');
    expect(html).not.toContain('Saved, all time');
  });

  it('preserves known zero cost and free cached-input prices', () => {
    const result = dashboard.computeSavings([{ ...row, actualUsdcPaid: 0 }], 'baseline');
    expect(result.baselineUsd).toBeCloseTo(0.0009);
    expect(result.actualUsd).toBe(0);
    expect(dashboard.fmtUsd(0)).toBe('$0');
  });

  it.each([null, undefined, NaN, Infinity, -1, '0'])('excludes unknown or invalid actual cost %s', (actualUsdcPaid) => {
    const rows = [{ ...row, actualUsdcPaid }];
    expect(dashboard.computeSavings(rows, 'baseline')).toBeNull();
    expect(dashboard.computeOpenRouterSavings(rows, 'baseline', price)).toBeNull();
    expect(dashboard.fmtUsd(actualUsdcPaid)).toBe('&mdash;');
  });

  it('compares matching valid rows only and does not fabricate aggregate zeros', () => {
    const rows = [row, { ...row, actualUsdcPaid: null }];
    expect(dashboard.computeSavings(rows, 'baseline').actualUsd).toBe(row.actualUsdcPaid);
    expect(dashboard.computeOpenRouterSavings(rows, 'baseline', price).actualUsd).toBe(row.actualUsdcPaid);
    expect(dashboard.statsRowHtml([], 'baseline')).not.toContain('$0');
    expect(dashboard.statsRowHtml(rows, 'baseline')).toContain('Observed / estimated cost');
  });

  it('rejects malformed usage and incomplete prices', () => {
    for (const overrides of [{ actualPromptTokens: -1 }, { actualCachedTokens: 101 }, { actualCompletionTokens: null }]) {
      expect(dashboard.computeSavings([{ ...row, ...overrides }], 'baseline')).toBeNull();
    }
    expect(dashboard.computeOpenRouterSavings([row], 'baseline', { inUsdPerM: 10 })).toBeNull();
    expect(dashboard.computeSavings([{ ...row, baselinePrices: { baseline: { ...price, outUsdPerM: NaN } } }], 'baseline')).toBeNull();
  });
});
