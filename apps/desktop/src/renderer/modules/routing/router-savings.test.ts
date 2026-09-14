import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RoutingDecisionRow } from '@antseed/node';
import { computeRecentRouterSavings, computeRouterSavings, defaultRouterSavingsBaselineModel, SEVEN_DAYS_MS } from './router-savings.js';

const BASELINE_PRICE = { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: 1.5 };

function row(overrides: Partial<RoutingDecisionRow> = {}): RoutingDecisionRow {
  return {
    atMs: Date.now(),
    actualModel: 'kimi-k3',
    actualPeer: '0xAAA',
    actualPromptTokens: 1000,
    actualCachedTokens: 0,
    actualCompletionTokens: 200,
    actualUsdcPaid: 0.0005,
    predictedCostUsd: 0.0005,
    predictedInputTokens: 1000,
    predictedCachedInputTokens: 0,
    predictedOutputTokens: 200,
    cqt: 5,
    routingLatencyMs: 50,
    baselinePrices: { [defaultRouterSavingsBaselineModel()]: BASELINE_PRICE },
    conversationKey: null,
    ...overrides,
  };
}

test('returns null with no rows', () => {
  assert.equal(computeRouterSavings([]), null);
});

test('unknown cost does not become free service or inflate savings', () => {
  assert.equal(computeRouterSavings([row({ actualUsdcPaid: null })]), null);
  assert.deepEqual(computeRouterSavings([row(), row({ actualUsdcPaid: null })]), computeRouterSavings([row()]));
});

test('forecasts are not required for comparisons and a known zero cost stays valid', () => {
  assert.equal(computeRouterSavings([row({ actualUsdcPaid: 0, predictedCostUsd: undefined, cqt: undefined })])?.pct, 100);
});

test('invalid price and usage snapshots cannot produce savings', () => {
  assert.equal(computeRouterSavings([row({ actualCachedTokens: 1001 })]), null);
  assert.equal(computeRouterSavings([row({ baselinePrices: { [defaultRouterSavingsBaselineModel()]: { inUsdPerM: NaN, outUsdPerM: 1, cachedInUsdPerM: null } } })]), null);
});

test('computes real savings against the row-level baselinePrices snapshot', () => {
  const result = computeRouterSavings([row()]);
  assert.ok(result);
  // baseline: 1000*15/1e6 + 200*75/1e6 = 0.015 + 0.015 = 0.03
  assert.ok(Math.abs(result!.baselineUsd - 0.03) < 1e-9);
  assert.equal(result!.actualUsd, 0.0005);
  assert.equal(result!.matchedServices, 1);
  assert.ok(result!.pct > 90); // paid far below the baseline model's price
});

test('excludes a row whose baselinePrices has no entry for the reference model (not offered at that decision)', () => {
  const result = computeRouterSavings([row({ baselinePrices: {} })]);
  assert.equal(result, null);
});

test('respects an explicit baselineModel argument, not just the default', () => {
  const withOther = row({
    baselinePrices: { 'gpt-5.6-sol': { inUsdPerM: 1.1, outUsdPerM: 8.9, cachedInUsdPerM: null } },
  });
  assert.equal(computeRouterSavings([withOther]), null); // default baseline model absent
  const result = computeRouterSavings([withOther], 'gpt-5.6-sol');
  assert.ok(result);
  // baseline: 1000*1.1/1e6 + 200*8.9/1e6 = 0.0011 + 0.00178 = 0.00288
  assert.ok(Math.abs(result!.baselineUsd - 0.00288) < 1e-9);
});

test('splits fresh vs cached tokens from the combined actualPromptTokens field', () => {
  const result = computeRouterSavings([
    row({ actualPromptTokens: 1000, actualCachedTokens: 400, actualCompletionTokens: 0 }),
  ]);
  // fresh 600 * 15/1e6 + cached 400 * 1.5/1e6 = 0.009 + 0.0006 = 0.0096
  assert.ok(result);
  assert.ok(Math.abs(result!.baselineUsd - 0.0096) < 1e-9);
});

test('falls back to the input price when cachedInUsdPerM is null', () => {
  const result = computeRouterSavings([
    row({
      actualPromptTokens: 1000,
      actualCachedTokens: 400,
      actualCompletionTokens: 0,
      baselinePrices: { [defaultRouterSavingsBaselineModel()]: { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: null } },
    }),
  ]);
  // fresh 600 * 15/1e6 + cached 400 * 15/1e6 (falls back to inUsdPerM) = 0.009 + 0.006 = 0.015
  assert.ok(result);
  assert.ok(Math.abs(result!.baselineUsd - 0.015) < 1e-9);
});

test('counts distinct matched models, not rows', () => {
  const result = computeRouterSavings([row(), row(), row({ actualModel: 'kimi-k3' })]);
  assert.ok(result);
  assert.equal(result!.matchedServices, 1);
});

test('clamps a paid-above-baseline scenario to 0%, never negative', () => {
  const result = computeRouterSavings([row({ actualUsdcPaid: 1 })]); // way above the 0.03 baseline
  assert.ok(result);
  assert.equal(result!.pct, 0);
});

test('computeRecentRouterSavings only counts rows within the window', () => {
  const now = 10_000_000;
  const rows = [
    row({ atMs: now - 1000, actualUsdcPaid: 0.001 }), // inside a 7-day window
    row({ atMs: now - SEVEN_DAYS_MS - 1, actualUsdcPaid: 0.001 }), // just outside
  ];
  const withinWindow = computeRecentRouterSavings(rows, SEVEN_DAYS_MS, now);
  const oneRowOnly = computeRouterSavings([rows[0]!]);
  assert.deepEqual(withinWindow, oneRowOnly);
});

test('computeRecentRouterSavings returns null with no rows in the window', () => {
  const now = 10_000_000;
  const rows = [row({ atMs: now - SEVEN_DAYS_MS - 1 })];
  assert.equal(computeRecentRouterSavings(rows, SEVEN_DAYS_MS, now), null);
});

test('computeRecentRouterSavings returns null for undefined rows', () => {
  assert.equal(computeRecentRouterSavings(undefined, SEVEN_DAYS_MS, Date.now()), null);
});
