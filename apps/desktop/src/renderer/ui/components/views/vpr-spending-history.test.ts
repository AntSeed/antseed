import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildSpendingChartModel,
  formatSpendUsd,
  spendingBarHeight,
} from './vpr-spending-history';

const NOW_MS = Date.UTC(2026, 7, 10, 12);

test('buildSpendingChartModel fills missing UTC days in a seven-day range', () => {
  const model = buildSpendingChartModel([
    { day: '2026-08-04', dayStart: 1_785_801_600, spentUsdc: '100000', inputTokens: '100', outputTokens: '20' },
    { day: '2026-08-10', dayStart: 1_786_320_000, spentUsdc: '250000', inputTokens: '200', outputTokens: '30' },
  ], 7, NOW_MS);

  assert.equal(model.buckets.length, 7);
  assert.deepEqual(model.buckets.map((bucket) => bucket.axisLabel), ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon']);
  assert.deepEqual(model.buckets.map((bucket) => bucket.spentUsdc), ['100000', '0', '0', '0', '0', '0', '250000']);
  assert.equal(model.totalSpentUsdc, '350000');
  assert.equal(model.totalInputTokens, '300');
  assert.equal(model.totalOutputTokens, '50');
});

test('buildSpendingChartModel creates thirty daily buckets and excludes older spend', () => {
  const model = buildSpendingChartModel([
    { day: '2026-07-11', dayStart: 1_783_728_000, spentUsdc: '999999', inputTokens: '900', outputTokens: '90' },
    { day: '2026-07-12', dayStart: 1_783_814_400, spentUsdc: '10000', inputTokens: '10', outputTokens: '1' },
  ], 30, NOW_MS);

  assert.equal(model.buckets.length, 30);
  assert.equal(model.buckets[0]?.spentUsdc, '10000');
  assert.equal(model.totalSpentUsdc, '10000');
  assert.equal(model.totalInputTokens, '10');
  assert.equal(model.totalOutputTokens, '1');
});

test('buildSpendingChartModel groups a strict ninety-day window into thirteen weekly buckets', () => {
  const firstDay = 1_778_630_400;
  const model = buildSpendingChartModel([
    { day: '2026-05-13', dayStart: firstDay, spentUsdc: '10000', inputTokens: '10', outputTokens: '1' },
    { day: '2026-05-19', dayStart: firstDay + (6 * 86_400), spentUsdc: '20000', inputTokens: '20', outputTokens: '2' },
    { day: '2026-05-20', dayStart: firstDay + (7 * 86_400), spentUsdc: '30000', inputTokens: '30', outputTokens: '3' },
    { day: '2026-08-10', dayStart: 1_786_320_000, spentUsdc: '40000', inputTokens: '40', outputTokens: '4' },
  ], 90, NOW_MS);

  assert.equal(model.buckets.length, 13);
  assert.equal(model.buckets[0]?.spentUsdc, '30000');
  assert.equal(model.buckets[1]?.spentUsdc, '30000');
  assert.equal(model.buckets[12]?.spentUsdc, '40000');
  assert.equal(model.totalSpentUsdc, '100000');
  assert.equal(model.totalInputTokens, '100');
  assert.equal(model.totalOutputTokens, '10');
});

test('spendingBarHeight normalizes values and keeps non-zero bars visible', () => {
  assert.equal(spendingBarHeight('0', '1000'), 0);
  assert.equal(spendingBarHeight('1', '1000'), 4);
  assert.equal(spendingBarHeight('500', '1000'), 50);
  assert.equal(spendingBarHeight('1000', '1000'), 100);
});

test('formatSpendUsd formats compact totals and exact tooltip values', () => {
  assert.equal(formatSpendUsd('0'), '$0.00');
  assert.equal(formatSpendUsd('1'), '<$0.01');
  assert.equal(formatSpendUsd('125000'), '$0.13');
  assert.equal(formatSpendUsd('125000', true), '$0.125');
  assert.equal(formatSpendUsd('2000000', true), '$2.00');
});
