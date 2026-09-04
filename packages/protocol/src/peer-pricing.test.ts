import { describe, expect, it } from 'vitest';
import { parseProviderPricing, snapshotProviderPricing } from './peer-pricing.js';
import { decodePaymentRequired, encodePaymentRequired } from './payment-codec.js';

describe('quoted provider prices', () => {
  const pricing = { openai: { defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 1 }, services: { model: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } } };

  it('round trips the complete price snapshot alongside legacy quote fields', () => {
    const quote = { minBudgetPerRequest: '100', suggestedAmount: '1000', requestId: 'request', providerPricing: pricing };
    expect(decodePaymentRequired(encodePaymentRequired(quote))).toEqual(quote);
    const legacy = { minBudgetPerRequest: '100', suggestedAmount: '1000', requestId: 'request' };
    expect(decodePaymentRequired(encodePaymentRequired(legacy))).toEqual(legacy);
  });

  it.each([null, [], { openai: null }, { openai: { defaults: { inputUsdPerMillion: -1, outputUsdPerMillion: 2 } } }, { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 3 } } }])('rejects malformed pricing %j', (value) => {
    expect(() => parseProviderPricing(value)).toThrow();
  });

  it('expands defaults per service without mixing same-name provider instances', () => {
    const snapshot = snapshotProviderPricing([
      { provider: 'openai', services: ['first'], defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      { provider: 'openai', services: ['second'], defaultPricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 4 } },
    ]);
    expect(snapshot.openai!.services!.first!.inputUsdPerMillion).toBe(1);
    expect(snapshot.openai!.services!.second!.inputUsdPerMillion).toBe(3);
  });
});
