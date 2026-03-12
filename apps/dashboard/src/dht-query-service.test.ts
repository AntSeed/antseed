import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveDiscoveryProviders,
  resolveMetadataSummaryPricing,
  resolveNetworkPeerServices,
  resolveNetworkPeerProviders,
} from './dht-query-service.js';

test('metadata default pricing maps to input/output USD per million', () => {
  const pricing = resolveMetadataSummaryPricing({
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-sonnet-4-5-20250929'],
        defaultPricing: {
          inputUsdPerMillion: 11,
          outputUsdPerMillion: 33,
        },
        maxConcurrency: 5,
        currentLoad: 0,
      },
    ],
  } as any);

  assert.equal(pricing.inputUsdPerMillion, 11);
  assert.equal(pricing.outputUsdPerMillion, 33);
});

test('missing model-specific pricing still resolves provider defaults', () => {
  const pricing = resolveMetadataSummaryPricing(
    {
      providers: [
        {
          provider: 'openai',
          services: ['gpt-4o', 'gpt-4o-mini'],
          defaultPricing: {
            inputUsdPerMillion: 7,
            outputUsdPerMillion: 21,
          },
          maxConcurrency: 8,
          currentLoad: 0,
        },
      ],
    } as any,
    ['openai'],
  );

  assert.equal(pricing.inputUsdPerMillion, 7);
  assert.equal(pricing.outputUsdPerMillion, 21);
});

test('discovery providers include buyer preferred and known defaults', () => {
  const providers = resolveDiscoveryProviders({
    seller: { enabledProviders: [] },
    buyer: { preferredProviders: ['claude-code'] },
  } as any);

  assert.ok(providers.includes('claude-code'));
  assert.ok(providers.includes('anthropic'));
  assert.ok(providers.includes('openai'));
});

test('discovery providers normalize package aliases and dedupe', () => {
  const providers = resolveDiscoveryProviders({
    seller: { enabledProviders: ['@antseed/provider-claude-code', 'claude-code'] },
    buyer: { preferredProviders: ['antseed-provider-openai', 'openai'] },
  } as any);

  const claudeCodeCount = providers.filter((p) => p === 'claude-code').length;
  const openaiCount = providers.filter((p) => p === 'openai').length;

  assert.equal(claudeCodeCount, 1);
  assert.equal(openaiCount, 1);
});

test('network peer providers prefer metadata providers over topic inference', () => {
  const providers = resolveNetworkPeerProviders(
    {
      providers: [
        {
          provider: 'claude-code',
          services: ['x'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    } as any,
    ['local-llm'],
    'local-llm',
  );

  assert.deepEqual(providers, ['claude-code']);
});

test('network peer providers fallback accumulates inferred topics when metadata is unavailable', () => {
  const providers = resolveNetworkPeerProviders(
    null,
    ['@antseed/provider-openai'],
    'openai',
  );

  assert.deepEqual(providers, ['openai']);
});

test('network peer models are extracted from metadata announcements', () => {
  const models = resolveNetworkPeerServices(
    {
      providers: [
        {
          provider: 'anthropic',
          services: ['claude-sonnet-4.6', 'claude-opus-4.1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    } as any,
    ['legacy-model'],
  );

  assert.deepEqual(models, ['claude-sonnet-4.6', 'claude-opus-4.1']);
});

test('network peer models fallback keeps existing model list when metadata is unavailable', () => {
  const models = resolveNetworkPeerServices(null, ['claude-sonnet-4.6', 'gpt-4.1']);
  assert.deepEqual(models, ['claude-sonnet-4.6', 'gpt-4.1']);
});
