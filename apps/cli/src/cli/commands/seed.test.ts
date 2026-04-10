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
  config.seller.providers = {
    anthropic: {
      defaults: { inputUsdPerMillion: 12, outputUsdPerMillion: 18 },
      services: {},
    },
  };
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
  assert.equal(effective.providers.anthropic?.defaults?.inputUsdPerMillion, 44);
  assert.equal(effective.providers.anthropic?.defaults?.outputUsdPerMillion, 55);
  assert.deepEqual(config, beforeResolution);
});

test('buildSellerPluginRuntimeEnv translates unified config into flat ANTSEED_* keys', () => {
  const config = createDefaultConfig();
  config.seller.maxConcurrentBuyers = 17;
  config.seller.providers = {
    anthropic: {
      defaults: {
        inputUsdPerMillion: 15,
        outputUsdPerMillion: 35,
        cachedInputUsdPerMillion: 1.5,
      },
      services: {
        'claude-sonnet-4-5-20250929': {
          upstreamModel: 'claude-sonnet-4-5-20250929',
          categories: ['coding', 'chat'],
          pricing: {
            inputUsdPerMillion: 18,
            outputUsdPerMillion: 42,
          },
        },
        'claude-opus-4-5': {
          upstreamModel: 'anthropic/claude-opus-4-5-20251117',
          categories: ['reasoning'],
        },
      },
    },
  };

  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'anthropic');

  assert.equal(runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'], '15');
  assert.equal(runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'], '35');
  assert.equal(runtimeEnv['ANTSEED_CACHED_INPUT_USD_PER_MILLION'], '1.5');
  assert.equal(runtimeEnv['ANTSEED_MAX_CONCURRENCY'], '17');

  // ANTSEED_ALLOWED_SERVICES is derived from the services map keys.
  const allowed = (runtimeEnv['ANTSEED_ALLOWED_SERVICES'] ?? '').split(',').sort();
  assert.deepEqual(allowed, ['claude-opus-4-5', 'claude-sonnet-4-5-20250929']);

  const services = JSON.parse(runtimeEnv['ANTSEED_SERVICE_PRICING_JSON'] ?? '{}') as Record<string, {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  }>;
  assert.equal(services['claude-sonnet-4-5-20250929']?.inputUsdPerMillion, 18);
  assert.equal(services['claude-sonnet-4-5-20250929']?.outputUsdPerMillion, 42);
  assert.equal(services['claude-opus-4-5'], undefined);

  const categories = JSON.parse(runtimeEnv['ANTSEED_SERVICE_CATEGORIES_JSON'] ?? '{}') as Record<string, string[]>;
  assert.deepEqual(categories['claude-sonnet-4-5-20250929'], ['coding', 'chat']);
  assert.deepEqual(categories['claude-opus-4-5'], ['reasoning']);

  const aliases = JSON.parse(runtimeEnv['ANTSEED_SERVICE_ALIAS_MAP_JSON'] ?? '{}') as Record<string, string>;
  assert.equal(aliases['claude-opus-4-5'], 'anthropic/claude-opus-4-5-20251117');
  // When upstream == serviceId, no alias entry is emitted.
  assert.equal(aliases['claude-sonnet-4-5-20250929'], undefined);
});

test('buildSellerPluginRuntimeEnv returns bare env when no provider is configured', () => {
  const config = createDefaultConfig();
  config.seller.maxConcurrentBuyers = 7;
  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'openai');
  assert.equal(runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'], undefined);
  assert.equal(runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'], undefined);
  assert.equal(runtimeEnv['ANTSEED_ALLOWED_SERVICES'], undefined);
  assert.equal(runtimeEnv['ANTSEED_MAX_CONCURRENCY'], '7');
});

test('buildSellerPluginRuntimeEnv sets OPENAI_BASE_URL from provider baseUrl', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    openai: {
      baseUrl: 'https://api.together.ai',
      services: {
        'qwen3.5-9b': {},
      },
    },
  };
  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'openai');
  assert.equal(runtimeEnv['OPENAI_BASE_URL'], 'https://api.together.ai');
});

test('seed merge keeps explicit pricing when runtime env also contains pricing and force override is off', () => {
  const merged = mergeSellerRuntimeEnv(
    {
      ANTSEED_INPUT_USD_PER_MILLION: '0.05',
      ANTSEED_OUTPUT_USD_PER_MILLION: '0.1',
    },
    {
      ANTSEED_INPUT_USD_PER_MILLION: '3',
      ANTSEED_OUTPUT_USD_PER_MILLION: '15',
      ANTSEED_MAX_CONCURRENCY: '10',
    },
  );

  assert.equal(merged['ANTSEED_INPUT_USD_PER_MILLION'], '0.05');
  assert.equal(merged['ANTSEED_OUTPUT_USD_PER_MILLION'], '0.1');
  assert.equal(merged['ANTSEED_MAX_CONCURRENCY'], '10');
});
