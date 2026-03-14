import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveMetadataSummaryPricing,
  resolveNetworkPeerServices,
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

test('missing service-specific pricing still resolves provider defaults', () => {
  const pricing = resolveMetadataSummaryPricing({
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
  } as any);

  assert.equal(pricing.inputUsdPerMillion, 7);
  assert.equal(pricing.outputUsdPerMillion, 21);
});

test('network peer services are extracted from metadata announcements', () => {
  const services = resolveNetworkPeerServices(
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
    ['legacy-service'],
  );

  assert.deepEqual(services, ['claude-sonnet-4.6', 'claude-opus-4.1']);
});

test('network peer services fallback keeps existing service list when metadata is unavailable', () => {
  const services = resolveNetworkPeerServices(null, ['claude-sonnet-4.6', 'gpt-4.1']);
  assert.deepEqual(services, ['claude-sonnet-4.6', 'gpt-4.1']);
});
