import { describe, expect, it } from 'vitest';
import { serviceBillingOffering, parseMicroUsdc, resolveServiceBillingOffer } from './service-billing.js';

const offer = { provider: 'levanto', service: 'levanto-route', serviceApiProtocol: 'levanto-routing' as const, priceMicroUsdc: '1000' };

describe('completed-request signed offerings', () => {
  it.each(['0', '1', '1000', '40000'])('round-trips %s micro-USDC through float32', priceMicroUsdc => {
    const expected = { ...offer, priceMicroUsdc };
    expect(resolveServiceBillingOffer([serviceBillingOffering(expected)], offer.provider, offer.service)).toEqual(expected);
  });
  it.each(['-1', '01', '1.1', '1e3', '9007199254740992'])('rejects invalid price %s', price => {
    expect(() => parseMicroUsdc(price)).toThrow();
  });
  it('rejects prices whose micro-USDC value changes in float32', () => {
    expect(() => serviceBillingOffering({ ...offer, priceMicroUsdc: '16777217' })).toThrow('round-trip');
  });
  it('requires one exact provider/service match', () => {
    const metadata = serviceBillingOffering(offer);
    expect(() => resolveServiceBillingOffer([], offer.provider, offer.service)).toThrow();
    expect(() => resolveServiceBillingOffer([metadata, metadata], offer.provider, offer.service)).toThrow('ambiguous');
    expect(() => resolveServiceBillingOffer([metadata], 'other', offer.service)).toThrow();
    expect(() => resolveServiceBillingOffer([metadata], offer.provider, 'other')).toThrow();
  });
  it('rejects invalid units and nonfinite advertised prices', () => {
    const metadata = serviceBillingOffering(offer);
    expect(() => resolveServiceBillingOffer([{ ...metadata, pricing: { ...metadata.pricing, unit: 'token' } }], offer.provider, offer.service)).toThrow();
    expect(() => resolveServiceBillingOffer([{ ...metadata, pricing: { ...metadata.pricing, pricePerUnit: Infinity } }], offer.provider, offer.service)).toThrow();
  });
});
