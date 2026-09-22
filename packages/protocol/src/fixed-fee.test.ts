import { describe, expect, it } from 'vitest';
import { fixedFeeOffering, parseMicroUsdc, resolveFixedFeeOffer } from './fixed-fee.js';

const offer = { provider: 'levanto', service: 'levanto-route', contract: 'levanto-routing-v1', priceMicroUsdc: '1000' };

describe('fixed-fee signed offerings', () => {
  it.each(['0', '1', '1000', '40000'])('round-trips %s micro-USDC through float32', priceMicroUsdc => {
    const expected = { ...offer, priceMicroUsdc };
    expect(resolveFixedFeeOffer([fixedFeeOffering(expected)], offer.provider, offer.service)).toEqual(expected);
  });
  it.each(['-1', '01', '1.1', '1e3', '9007199254740992'])('rejects invalid price %s', price => {
    expect(() => parseMicroUsdc(price)).toThrow();
  });
  it('rejects prices whose micro-USDC value changes in float32', () => {
    expect(() => fixedFeeOffering({ ...offer, priceMicroUsdc: '16777217' })).toThrow('round-trip');
  });
  it('requires one exact provider/service match', () => {
    const metadata = fixedFeeOffering(offer);
    expect(() => resolveFixedFeeOffer([], offer.provider, offer.service)).toThrow();
    expect(() => resolveFixedFeeOffer([metadata, metadata], offer.provider, offer.service)).toThrow('ambiguous');
    expect(() => resolveFixedFeeOffer([metadata], 'other', offer.service)).toThrow();
    expect(() => resolveFixedFeeOffer([metadata], offer.provider, 'other')).toThrow();
  });
  it('rejects invalid units and nonfinite advertised prices', () => {
    const metadata = fixedFeeOffering(offer);
    expect(() => resolveFixedFeeOffer([{ ...metadata, pricing: { ...metadata.pricing, unit: 'token' } }], offer.provider, offer.service)).toThrow();
    expect(() => resolveFixedFeeOffer([{ ...metadata, pricing: { ...metadata.pricing, pricePerUnit: Infinity } }], offer.provider, offer.service)).toThrow();
  });
});
