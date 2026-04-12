import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../../config/defaults.js';
import { resolveEffectiveSellerConfig } from '../../../config/effective.js';
import {
  assertSellerPrerequisites,
  buildSellerRuntimeOverridesFromFlags,
  buildSellerPluginRuntimeEnv,
  mergeSellerRuntimeEnv,
  selectSellerProviderNames,
} from './start.js';

test('seller start runtime overrides are runtime-only and win over env/config', () => {
  const config = createDefaultConfig();
  config.seller.reserveFloor = 11;
  config.seller.providers = {
    anthropic: {
      plugin: 'anthropic',
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
      plugin: 'anthropic',
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

  // Categories are intentionally NOT emitted as an env var — plugins don't
  // read them from env. The CLI writes them directly onto
  // `provider.serviceCategories` inside the seed action.
  assert.equal(runtimeEnv['ANTSEED_SERVICE_CATEGORIES_JSON'], undefined);

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
      plugin: 'openai',
      baseUrl: 'https://api.together.ai',
      services: {
        'qwen3.5-9b': {},
      },
    },
  };
  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'openai');
  assert.equal(runtimeEnv['OPENAI_BASE_URL'], 'https://api.together.ai');
});

test('assertSellerPrerequisites fails when no services are configured', async () => {
  const config = createDefaultConfig();
  const seller = config.seller;
  await assert.rejects(
    async () =>
      assertSellerPrerequisites({
        dataDir: '/tmp/no-identity-here',
        config,
        effectiveSeller: seller,
        providerNames: ['anthropic'],
        paymentsEnabled: false,
        runtimePricingOverride: false,
        skipChainChecks: true,
      }),
    /seller prerequisites not met/,
  );
});

test('assertSellerPrerequisites fails when pricing override has no providers to apply to', async () => {
  const config = createDefaultConfig();
  const seller = config.seller;
  await assert.rejects(
    async () =>
      assertSellerPrerequisites({
        dataDir: '/tmp/no-identity-here',
        config,
        effectiveSeller: seller,
        providerNames: ['anthropic'],
        paymentsEnabled: false,
        runtimePricingOverride: true,
        skipChainChecks: true,
      }),
    /seller prerequisites not met/,
  );
});

test('assertSellerPrerequisites passes when services are configured and chain checks are skipped', async () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: {
      plugin: 'anthropic',
      defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
      services: {
        'claude-sonnet-4-5-20250929': {
          pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
        },
      },
    },
  };
  await assertSellerPrerequisites({
    dataDir: '/tmp/no-identity-here',
    config,
    effectiveSeller: config.seller,
    providerNames: ['anthropic'],
    paymentsEnabled: false,
    runtimePricingOverride: false,
    skipChainChecks: true,
  });
});

test('assertSellerPrerequisites fails when any selected provider has no services', async () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: {
      plugin: 'anthropic',
      services: {
        'claude-sonnet-4-5-20250929': {},
      },
    },
    together: {
      plugin: 'openai',
      services: {},
    },
  };

  await assert.rejects(
    async () =>
      assertSellerPrerequisites({
        dataDir: '/tmp/no-identity-here',
        config,
        effectiveSeller: config.seller,
        providerNames: ['anthropic', 'together'],
        paymentsEnabled: false,
        runtimePricingOverride: false,
        skipChainChecks: true,
      }),
    /seller prerequisites not met/,
  );
});

test('seller start merge keeps explicit pricing when runtime env also contains pricing and force override is off', () => {
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

test('selectSellerProviderNames defaults to all configured providers', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: { plugin: 'anthropic', services: {} },
    together: { plugin: 'openai', services: {} },
  };

  const selection = selectSellerProviderNames(config.seller);

  assert.deepEqual(selection.selected, ['anthropic', 'together']);
  assert.deepEqual(selection.unknown, []);
});

test('selectSellerProviderNames parses comma-separated provider filters and reports unknown names', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: { plugin: 'anthropic', services: {} },
    together: { plugin: 'openai', services: {} },
  };

  const selection = selectSellerProviderNames(config.seller, 'together, missing');

  assert.deepEqual(selection.selected, ['together', 'missing']);
  assert.deepEqual(selection.unknown, ['missing']);
});
