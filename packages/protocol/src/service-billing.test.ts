import { describe, expect, it } from 'vitest';
import { parseMicroUsdc, resolveCompletedRequestPrice, resolveServiceBillingOffer } from './service-billing.js';
import type { ProviderAnnouncement } from './peer-metadata.js';

const offer = { provider: 'levanto', service: 'levanto-route', serviceApiProtocol: 'levanto-routing' as const, priceMicroUsdc: '1000' };

function announcement(priceMicroUsdc = offer.priceMicroUsdc): ProviderAnnouncement {
  return {
    provider: offer.provider, services: [offer.service], maxConcurrency: 1, currentLoad: 0,
    defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    serviceApiProtocols: { [offer.service]: [offer.serviceApiProtocol] },
    serviceUnitBillingModels: { [offer.service]: { [offer.serviceApiProtocol]: {
      version: 1, components: [{ unit: 'completed_requests', priceUsd: Number(priceMicroUsdc) / 1_000_000 }],
    } } },
  };
}

describe('native completed-request prices', () => {
  it('uses the shared resolver for equivalent prices across protocols', () => {
    const provider = announcement();
    provider.serviceApiProtocols![offer.service]!.push('typesafe-systemone');
    const models = provider.serviceUnitBillingModels![offer.service]!;
    models['typesafe-systemone'] = {
      version: 1, components: [{ unit: 'completed_requests', priceUsd: Math.fround(0.001) }],
    };
    expect(resolveCompletedRequestPrice(models)).toEqual({ serviceApiProtocol: offer.serviceApiProtocol, priceMicroUsdc: offer.priceMicroUsdc });
    expect(resolveServiceBillingOffer([provider], offer.provider, offer.service)).toEqual(offer);
  });
  it('rejects missing prices, image components and unknown protocols in the shared resolver', () => {
    expect(() => resolveCompletedRequestPrice(undefined)).toThrow('Missing');
    expect(() => resolveCompletedRequestPrice({})).toThrow('Missing');
    const models = announcement().serviceUnitBillingModels![offer.service]!;
    models['openai-images'] = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };
    expect(() => resolveCompletedRequestPrice(models)).toThrow('Invalid');
    expect(() => resolveCompletedRequestPrice({ unknown: models['levanto-routing'] } as typeof models)).toThrow('Invalid');
  });
  it('requires a price for every advertised protocol', () => {
    const provider = announcement();
    provider.serviceApiProtocols![offer.service]!.push('typesafe-systemone');
    expect(() => resolveServiceBillingOffer([provider], offer.provider, offer.service)).toThrow('Missing');
  });
  it.each(['0', '1', '1000', '40000'])('converts advertised USD into %s micro-USDC', priceMicroUsdc => {
    expect(resolveServiceBillingOffer([announcement(priceMicroUsdc)], offer.provider, offer.service)).toEqual({ ...offer, priceMicroUsdc });
  });
  it.each(['-1', '01', '1.1', '1e3', '9007199254740992'])('rejects invalid price %s', price => {
    expect(() => parseMicroUsdc(price)).toThrow();
  });
  it.each(['-1', 'NaN', '16777217', '9007199254740991'])('rejects invalid or imprecise advertised price %s', price => {
    expect(() => resolveServiceBillingOffer([announcement(price)], offer.provider, offer.service)).toThrow();
  });
  it('requires one exact provider/service match', () => {
    const provider = announcement();
    expect(() => resolveServiceBillingOffer([], offer.provider, offer.service)).toThrow();
    expect(() => resolveServiceBillingOffer([provider, provider], offer.provider, offer.service)).toThrow('ambiguous');
    expect(() => resolveServiceBillingOffer([provider], 'other', offer.service)).toThrow();
    expect(() => resolveServiceBillingOffer([provider], offer.provider, 'other')).toThrow();
  });
  it('rejects missing models, image models and unadvertised protocols', () => {
    const provider = announcement();
    provider.serviceUnitBillingModels = {};
    expect(() => resolveServiceBillingOffer([provider], offer.provider, offer.service)).toThrow();
    provider.serviceUnitBillingModels = { [offer.service]: { 'levanto-routing': { version: 1, components: [] } } };
    expect(() => resolveServiceBillingOffer([provider], offer.provider, offer.service)).toThrow();
    const unadvertised = announcement();
    unadvertised.serviceApiProtocols = {};
    expect(() => resolveServiceBillingOffer([unadvertised], offer.provider, offer.service)).toThrow();
  });
  it('rejects conflicting prices across protocols', () => {
    const provider = announcement();
    provider.serviceApiProtocols![offer.service]!.push('typesafe-systemone');
    provider.serviceUnitBillingModels![offer.service]!['typesafe-systemone'] = {
      version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.002 }],
    };
    expect(() => resolveServiceBillingOffer([provider], offer.provider, offer.service)).toThrow('Ambiguous');
  });
});
