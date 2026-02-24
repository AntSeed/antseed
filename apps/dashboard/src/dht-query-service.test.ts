import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMetadataSummaryPricing } from './dht-query-service.js';

test('metadata default pricing maps to input/output USD per million', () => {
  const pricing = resolveMetadataSummaryPricing({
    providers: [
      {
        provider: 'anthropic',
        models: ['claude-sonnet-4-5-20250929'],
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
          models: ['gpt-4o', 'gpt-4o-mini'],
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
