import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../config/defaults.js';
import { resolveEffectiveBuyerConfig } from '../../config/effective.js';
import {
  buildBuyerRuntimeOverridesFromFlags,
  buildBuyerBootstrapEntries,
  buildRouterRuntimeEnvFromBuyerConfig,
} from './connect.js';

test('connect runtime overrides are runtime-only and win over env/config', () => {
  const config = createDefaultConfig();
  config.buyer.proxyPort = 7777;
  config.buyer.maxPricing.defaults.inputUsdPerMillion = 50;
  config.buyer.maxPricing.defaults.outputUsdPerMillion = 60;
  const beforeResolution = JSON.parse(JSON.stringify(config));

  const env = {
    ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '70',
    ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION: '80',
  } as NodeJS.ProcessEnv;

  const overrides = buildBuyerRuntimeOverridesFromFlags({
    port: 9000,
    maxInputUsdPerMillion: 90,
    maxOutputUsdPerMillion: 95,
  });

  const effective = resolveEffectiveBuyerConfig({
    config,
    env,
    buyerOverrides: overrides,
  });

  assert.equal(effective.proxyPort, 9000);
  assert.equal(effective.maxPricing.defaults.inputUsdPerMillion, 90);
  assert.equal(effective.maxPricing.defaults.outputUsdPerMillion, 95);
  assert.deepEqual(config, beforeResolution);
});

test('connect maps effective buyer config into router runtime env keys', () => {
  const config = createDefaultConfig();
  config.buyer.minPeerReputation = 72;
  config.buyer.maxPricing.defaults.inputUsdPerMillion = 21;
  config.buyer.maxPricing.defaults.outputUsdPerMillion = 63;

  const runtimeEnv = buildRouterRuntimeEnvFromBuyerConfig(config.buyer);
  assert.equal(runtimeEnv['ANTSEED_MIN_REPUTATION'], '72');

  const parsed = JSON.parse(runtimeEnv['ANTSEED_MAX_PRICING_JSON'] ?? '{}') as {
    defaults?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number };
  };
  assert.equal(parsed.defaults?.inputUsdPerMillion, 21);
  assert.equal(parsed.defaults?.outputUsdPerMillion, 63);
});

test('connect bootstrap entries use official nodes when config is empty and include local seeder first', () => {
  const entries = buildBuyerBootstrapEntries([], 6881);
  assert.equal(entries[0], '127.0.0.1:6881');
  assert.ok(entries.length > 1);
});

test('connect bootstrap entries respect explicit configured nodes', () => {
  const entries = buildBuyerBootstrapEntries(['10.0.0.2:6881'], 6889);
  assert.equal(entries[0], '127.0.0.1:6889');
  assert.deepEqual(entries.slice(1), ['10.0.0.2:6881']);
});
