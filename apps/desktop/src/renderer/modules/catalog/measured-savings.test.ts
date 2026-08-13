import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DesktopBuyerServiceUsage } from '../../types/bridge';
import { computeMeasuredSavings, formatSavedUsd } from './measured-savings.js';

function serviceUsage(overrides: Partial<DesktopBuyerServiceUsage> = {}): DesktopBuyerServiceUsage {
  return {
    serviceIdHash: '0x' + '11'.repeat(32),
    serviceName: 'gpt-4o',
    amountUsdc: '0',
    inputTokens: '0',
    cachedInputTokens: '0',
    outputTokens: '0',
    requestCount: 0,
    ...overrides,
  };
}

test('null without services or reference map', () => {
  assert.equal(computeMeasuredSavings(undefined, { 'gpt4o': { input: 1, output: 1 } }), null);
  assert.equal(computeMeasuredSavings([], { 'gpt4o': { input: 1, output: 1 } }), null);
  assert.equal(computeMeasuredSavings([serviceUsage()], null), null);
});

test('computes pct from actual spend vs retail baseline', () => {
  // 1M fresh input @ $10/M + 1M output @ $30/M = $40 retail; paid $20.
  const services = [serviceUsage({
    amountUsdc: String(20 * 1_000_000),
    inputTokens: String(1_000_000),
    outputTokens: String(1_000_000),
  })];
  const result = computeMeasuredSavings(services, { 'gpt4o': { input: 10, output: 30 } });
  assert.ok(result);
  assert.equal(result.pct, 50);
  assert.equal(result.matchedServices, 1);
  assert.ok(Math.abs(result.actualUsd - 20) < 1e-9);
  assert.ok(Math.abs(result.baselineUsd - 40) < 1e-9);
});

test('free usage counts as 100% savings', () => {
  const services = [serviceUsage({
    amountUsdc: '0',
    inputTokens: String(2_000_000),
    outputTokens: String(1_000_000),
  })];
  const result = computeMeasuredSavings(services, { 'gpt4o': { input: 5, output: 15 } });
  assert.ok(result);
  assert.equal(result.pct, 100);
});

test('cached input priced at cache-read rate when available', () => {
  // 1M input, all cached @ $1/M vs fresh $10/M. Paid $0.50 → baseline $1 → 50%.
  const services = [serviceUsage({
    amountUsdc: String(0.5 * 1_000_000),
    inputTokens: String(1_000_000),
    cachedInputTokens: String(1_000_000),
  })];
  const result = computeMeasuredSavings(services, { 'gpt4o': { input: 10, output: 30, cachedInput: 1 } });
  assert.ok(result);
  assert.equal(result.pct, 50);
});

test('unmatched services are excluded from both sides', () => {
  const services = [
    serviceUsage({
      amountUsdc: String(10 * 1_000_000),
      inputTokens: String(1_000_000),
    }),
    serviceUsage({
      serviceIdHash: '0x' + '22'.repeat(32),
      serviceName: 'unknown-model',
      amountUsdc: String(999 * 1_000_000),
      inputTokens: String(1_000_000),
    }),
  ];
  // Only gpt-4o matches: baseline $20, paid $10 → 50%.
  const result = computeMeasuredSavings(services, { 'gpt4o': { input: 20, output: 60 } });
  assert.ok(result);
  assert.equal(result.matchedServices, 1);
  assert.equal(result.pct, 50);
});

test('unresolved service names are skipped', () => {
  const services = [serviceUsage({ serviceName: null, inputTokens: String(1_000_000) })];
  assert.equal(computeMeasuredSavings(services, { 'gpt4o': { input: 10, output: 30 } }), null);
});

test('paying above retail clamps to 0, never negative', () => {
  const services = [serviceUsage({
    amountUsdc: String(100 * 1_000_000),
    inputTokens: String(1_000_000),
  })];
  const result = computeMeasuredSavings(services, { 'gpt4o': { input: 10, output: 30 } });
  assert.ok(result);
  assert.equal(result.pct, 0);
});

test('usage-weighted: heavy cheap model dominates light expensive one', () => {
  const services = [
    // 10M input @ retail $10/M = $100 baseline, paid $10 (90% off)
    serviceUsage({
      amountUsdc: String(10 * 1_000_000),
      inputTokens: String(10_000_000),
    }),
    // 0.1M input @ retail $10/M = $1 baseline, paid $1 (0% off)
    serviceUsage({
      serviceIdHash: '0x' + '22'.repeat(32),
      serviceName: 'claude-sonnet',
      amountUsdc: String(1 * 1_000_000),
      inputTokens: String(100_000),
    }),
  ];
  const result = computeMeasuredSavings(services, {
    'gpt4o': { input: 10, output: 30 },
    sonnet: { input: 10, output: 30 },
  });
  assert.ok(result);
  // total baseline $101, paid $11 → ~89% (weighted, not the 45% plain average)
  assert.equal(result.pct, 89);
});

test('formatSavedUsd renders compact USD labels', () => {
  assert.equal(formatSavedUsd(0), '$0');
  assert.equal(formatSavedUsd(-5), '$0');
  assert.equal(formatSavedUsd(0.004), '<$0.01');
  assert.equal(formatSavedUsd(0.42), '$0.42');
  assert.equal(formatSavedUsd(12.4), '$12.40');
  assert.equal(formatSavedUsd(1234), '$1.2k');
});

test('matches reference prices with the shared canonical model key', () => {
  const result = computeMeasuredSavings([
    serviceUsage({
      serviceName: 'claude-fable-5',
      amountUsdc: '1000000',
      inputTokens: '1000000',
    }),
  ], {
    fable5: { input: 5, output: 30 },
  });

  assert.ok(result);
  assert.equal(result.matchedServices, 1);
  assert.equal(result.baselineUsd, 5);
});
