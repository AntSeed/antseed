import { describe, expect, it } from 'vitest';
import { buildNetworkServiceOffers } from './service-catalog.js';

describe('buildNetworkServiceOffers', () => {
  it('projects provider-specific services, pricing, protocols, and image billing', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      displayName: 'Seller',
      providers: ['openai', 'anthropic'],
      reputationScore: 90,
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          services: { 'gpt-image-test': {} },
        },
        anthropic: {
          services: { 'claude-test': { inputUsdPerMillion: 3, outputUsdPerMillion: 9 } },
        },
      },
      providerServiceApiProtocols: {
        openai: { services: { 'gpt-image-test': ['openai-images'] } },
        anthropic: { services: { 'claude-test': ['anthropic-messages'] } },
      },
      providerServiceCapabilities: {
        openai: { services: { 'gpt-image-test': { inputs: ['text'], outputs: ['image'] } } },
      },
      providerServiceUnitBillingModels: {
        openai: {
          services: {
            'gpt-image-test': {
              'openai-images': {
                version: 1,
                components: [
                  { unit: 'output_images', priceUsd: 0.04 },
                  { unit: 'output_images', priceUsd: 0.08 },
                ],
              },
            },
          },
        },
      },
    }]);

    expect(offers).toHaveLength(2);
    expect(offers.find((offer) => offer.serviceId === 'gpt-image-test')).toMatchObject({
      provider: 'openai',
      protocol: 'openai-images',
      type: 'image',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.08,
    });
    expect(offers.find((offer) => offer.serviceId === 'claude-test')).toMatchObject({
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      type: 'text',
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 9,
    });
  });

  it('supports legacy peer-wide service lists', () => {
    expect(buildNetworkServiceOffers([{
      peerId: 'b'.repeat(40),
      providers: ['openai'],
      services: ['legacy-model'],
    }])).toMatchObject([{
      serviceId: 'legacy-model',
      provider: 'openai',
      protocol: 'openai-chat-completions',
      type: 'text',
    }]);
  });
});
