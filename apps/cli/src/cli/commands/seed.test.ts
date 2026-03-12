import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../config/defaults.js';
import { resolveEffectiveSellerConfig } from '../../config/effective.js';
import {
  buildSellerRuntimeOverridesFromFlags,
  buildSellerPluginRuntimeEnv,
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

  const models = JSON.parse(runtimeEnv['ANTSEED_SERVICE_PRICING_JSON'] ?? '{}') as Record<string, {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  }>;
  assert.equal(models['claude-sonnet-4-5-20250929']?.inputUsdPerMillion, 18);
  assert.equal(models['claude-sonnet-4-5-20250929']?.outputUsdPerMillion, 42);

  const categories = JSON.parse(runtimeEnv['ANTSEED_SERVICE_CATEGORIES_JSON'] ?? '{}') as Record<string, string[]>;
  assert.deepEqual(categories['claude-sonnet-4-5-20250929'], ['coding', 'legal']);
});
