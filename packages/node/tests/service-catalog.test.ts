import { describe, expect, it } from 'vitest';
import {
  buildNetworkServiceOffers,
  selectLowestPricedCanonicalOffers,
  type NetworkServiceCatalogPeer,
} from '../src/discovery/service-catalog.js';

function peer(overrides: Partial<NetworkServiceCatalogPeer>): NetworkServiceCatalogPeer {
  return { peerId: 'a'.repeat(40), ...overrides };
}

describe('network service catalog', () => {
  it('uses legacy services when provider pricing only announces defaults', () => {
    const offers = buildNetworkServiceOffers([peer({
      providers: ['openai'],
      services: ['gpt-4o'],
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      },
    })]);

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      provider: 'openai',
      serviceId: 'gpt-4o',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    });
  });

  it('keeps the unrestricted service when a cheaper coding-only alias exists', () => {
    const offers = buildNetworkServiceOffers([peer({
      providerPricing: {
        anthropic: { services: { 'claude-opus-5': { inputUsdPerMillion: 5, outputUsdPerMillion: 25 } } },
        'claude-oauth': { services: { 'opus-5-coding-only': { inputUsdPerMillion: 1, outputUsdPerMillion: 5 } } },
      },
      providerServiceApiProtocols: {
        anthropic: { services: { 'claude-opus-5': ['anthropic-messages'] } },
        'claude-oauth': { services: { 'opus-5-coding-only': ['anthropic-messages'] } },
      },
    })]);

    const selected = selectLowestPricedCanonicalOffers(offers);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.serviceId).toBe('claude-opus-5');
  });
});
