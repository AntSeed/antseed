import { describe, expect, it } from 'vitest';
import { createUnitBillingModel } from '../src/types/billing.js';
import {
  buildNetworkServiceOffers,
  selectLowestPricedCanonicalOffers,
  type NetworkServiceCatalogPeer,
} from '../src/discovery/service-catalog.js';

function peer(overrides: Partial<NetworkServiceCatalogPeer>): NetworkServiceCatalogPeer {
  return { peerId: 'a'.repeat(40), ...overrides };
}

describe('network service catalog', () => {
  it.each([false, true])('keeps per-protocol billing independent of protocol/model order (reversed: %s)', (reverse) => {
    const protocols = ['anthropic-messages', 'openai-chat-completions', 'openai-responses'];
    const models = [
      ['anthropic-messages', createUnitBillingModel('5000')],
      ['openai-chat-completions', createUnitBillingModel('16777217')],
      ['openai-responses', createUnitBillingModel('0')],
      ['openai-completions', createUnitBillingModel('2500')],
    ] as const;
    const offers = buildNetworkServiceOffers([peer({
      providerServiceApiProtocols: {
        openai: { services: { classifier: reverse ? [...protocols].reverse() : protocols } },
      },
      providerServiceUnitBillingModels: {
        openai: { services: { classifier: Object.fromEntries(reverse ? [...models].reverse() : models) } },
      },
      providerServiceCapabilities: {
        openai: { services: { classifier: { routing: true }, inference: { routing: false }, unknown: { toolUse: true } } },
      },
    })]);
    const classifier = offers.find((offer) => offer.serviceId === 'classifier')!;
    expect(classifier.capabilities?.routing).toBe(true);
    expect(classifier.billingByProtocol).toMatchObject({
      'anthropic-messages': { kind: 'per_quantity', amountMicroUsdc: '5000' },
      'openai-chat-completions': { kind: 'per_quantity', amountMicroUsdc: '16777217' },
      'openai-responses': { kind: 'per_quantity', amountMicroUsdc: '0' },
      'openai-completions': { kind: 'per_quantity', amountMicroUsdc: '2500' },
    });
    expect(classifier.billingByProtocol?.['openai-images']).toBeUndefined();
    expect(classifier.billing).toMatchObject({ kind: 'per_quantity', pricing: 'fixed', amountMicroUsdc: reverse ? '0' : '5000' });
    expect(offers.find((offer) => offer.serviceId === 'inference')?.capabilities?.routing).toBe(false);
    expect(offers.find((offer) => offer.serviceId === 'unknown')?.capabilities?.routing).toBeUndefined();
  });

  it('keeps the alternate protocol fee when the display protocol has token billing', () => {
    const metadata = peer({
      providerServiceApiProtocols: {
        openai: { services: { model: ['openai-chat-completions', 'openai-responses'] } },
      },
      providerServiceUnitBillingModels: {
        openai: { services: { model: { 'openai-responses': createUnitBillingModel('5000') } } },
      },
    });
    const offer = buildNetworkServiceOffers([metadata])[0]!;
    expect(offer.billing).toBeUndefined();
    expect(offer.billingByProtocol?.['openai-chat-completions']).toBeUndefined();
    expect(offer.billingByProtocol?.['openai-responses']).toMatchObject({ kind: 'per_quantity', pricing: 'fixed', amountMicroUsdc: '5000' });
    metadata.providerServiceUnitBillingModels!.openai!.services.model!['openai-responses']!.components[0]!.priceMicroUsdc = '1000000';
    expect(offer.billingByProtocol?.['openai-responses']?.amountMicroUsdc).toBe('5000');
  });

  it('exposes image quantity prices without inventing billing for token-only services', () => {
    const legacy = buildNetworkServiceOffers([peer({ providers: ['openai'], services: ['legacy'] })])[0]!;
    expect(legacy.billingByProtocol).toBeUndefined();
    const image = buildNetworkServiceOffers([peer({ providerServiceApiProtocols: { openai: { services: { image: ['openai-images'] } } }, providerServiceUnitBillingModels: { openai: { services: { image: { 'openai-images': createUnitBillingModel('40000') } } } } })])[0]!;
    expect(image.billingByProtocol?.['openai-images']).toEqual({ kind: 'per_quantity', pricing: 'fixed', model: createUnitBillingModel('40000'), amountMicroUsdc: '40000' });
  });

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

  it('does not assign every legacy service only to the first provider', () => {
    const offers = buildNetworkServiceOffers([peer({
      providers: ['anthropic', 'openai-responses'],
      services: ['claude-sonnet-4-5', 'gpt-5.6'],
    })]);

    expect(offers.map((offer) => ({
      provider: offer.provider,
      serviceId: offer.serviceId,
      protocol: offer.protocol,
    }))).toEqual([
      { provider: 'anthropic', serviceId: 'claude-sonnet-4-5', protocol: 'anthropic-messages' },
      { provider: 'anthropic', serviceId: 'gpt-5.6', protocol: 'anthropic-messages' },
      { provider: 'openai-responses', serviceId: 'claude-sonnet-4-5', protocol: 'openai-responses' },
      { provider: 'openai-responses', serviceId: 'gpt-5.6', protocol: 'openai-responses' },
    ]);
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
