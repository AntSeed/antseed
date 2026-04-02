import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../config/defaults.js';
import { resolveEffectiveSellerConfig } from '../../config/effective.js';
import {
  buildSellerRuntimeOverridesFromFlags,
  buildSellerPluginRuntimeEnv,
  mergeSellerRuntimeEnv,
} from './seed.js';

test('seed runtime overrides are runtime-only and win over env/config', () => {
  const config = createDefaultConfig();
  config.seller.reserveFloor = 11;
  config.seller.pricing.defaults.inputUsdPerMillion = 12;
  config.seller.pricing.defaults.outputUsdPerMillion = 18;
  const beforeResolution = JSON.parse(JSON.stringify(config));

  const env = {
    ANTSEED_SELLER_INPUT_USD_PER_MILLION: '20',
  } as NodeJS.ProcessEnv;

  const overrides = buildSellerRuntimeOverridesFromFlags({
    reserve: 33,
    inputUsdPerMillion: 44,
    outputUsdPerMillion: 55,
  });

  const effective = resolveEffectiveSellerConfig({
    config,
    env,
    sellerOverrides: overrides,
  });

  assert.equal(effective.reserveFloor, 33);
  assert.equal(effective.pricing.defaults.inputUsdPerMillion, 44);
  assert.equal(effective.pricing.defaults.outputUsdPerMillion, 55);
  assert.deepEqual(config, beforeResolution);
});

test('seed maps effective seller pricing into provider runtime keys', () => {
  const config = createDefaultConfig();
  config.seller.maxConcurrentBuyers = 17;
  config.seller.pricing.defaults.inputUsdPerMillion = 10;
  config.seller.pricing.defaults.outputUsdPerMillion = 20;
  config.seller.pricing.providers = {
    anthropic: {
      defaults: {
        inputUsdPerMillion: 15,
        outputUsdPerMillion: 35,
      },
      services: {
        'claude-sonnet-4-5-20250929': {
          inputUsdPerMillion: 18,
          outputUsdPerMillion: 42,
        },
      },
    },
  };
  config.seller.serviceCategories = {
    anthropic: {
      'claude-sonnet-4-5-20250929': ['coding', 'legal'],
    },
  };

  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'anthropic');
  assert.equal(runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'], '15');
  assert.equal(runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'], '35');
  assert.equal(runtimeEnv['ANTSEED_MAX_CONCURRENCY'], '17');

  const services = JSON.parse(runtimeEnv['ANTSEED_SERVICE_PRICING_JSON'] ?? '{}') as Record<string, {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  }>;
  assert.equal(services['claude-sonnet-4-5-20250929']?.inputUsdPerMillion, 18);
  assert.equal(services['claude-sonnet-4-5-20250929']?.outputUsdPerMillion, 42);

  const categories = JSON.parse(runtimeEnv['ANTSEED_SERVICE_CATEGORIES_JSON'] ?? '{}') as Record<string, string[]>;
  assert.deepEqual(categories['claude-sonnet-4-5-20250929'], ['coding', 'legal']);
});

test('seed does not override explicit provider instance pricing with seller defaults', () => {
  const config = createDefaultConfig();
  config.seller.pricing.defaults.inputUsdPerMillion = 3;
  config.seller.pricing.defaults.outputUsdPerMillion = 15;

  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'openai');
  assert.equal(runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'], undefined);
  assert.equal(runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'], undefined);

  const merged = mergeSellerRuntimeEnv(
    {
      OPENAI_API_KEY: 'test-key',
      ANTSEED_INPUT_USD_PER_MILLION: '0.05',
      ANTSEED_OUTPUT_USD_PER_MILLION: '0.1',
    },
    runtimeEnv,
  );
  assert.equal(merged['ANTSEED_INPUT_USD_PER_MILLION'], '0.05');
  assert.equal(merged['ANTSEED_OUTPUT_USD_PER_MILLION'], '0.1');
});
