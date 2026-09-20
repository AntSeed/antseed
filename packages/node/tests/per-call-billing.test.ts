import { describe, expect, it } from 'vitest';
import { createUnitBillingModel, unitPriceMicroUsdc, validateUnitBillingModelV2, validateUnitBillingUsage,
  computeFinalUnitBilling, evaluateUnitBilling, captureUnitBillingContext } from '../src/billing/unit.js';
import { buildNetworkServiceOffers, compareNetworkServiceOfferPrice } from '../src/discovery/service-catalog.js';
import type { UnitBillingContext } from '../src/types/billing.js';

const model = createUnitBillingModel('5000');
const context: UnitBillingContext = { sellerPeerId: 'a'.repeat(40), provider: 'openai', service: 'classifier', serviceApiProtocol: 'openai-chat-completions' };
const response = { requestId: 'call', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })) };

describe('per-call billing contract', () => {
  it.each(['0', '1', '5000', '16777217', '4294967295'])('represents exact micro-USDC amount %s', (amount) => {
    const pricing = createUnitBillingModel(amount);
    expect(unitPriceMicroUsdc(pricing)).toBe(BigInt(amount));
    expect(evaluateUnitBilling(pricing, context, { quantity: 1 })).toBe(BigInt(amount));
  });
  it.each(['-1', '1.1', '01', '5000.0', '1e3', 'NaN', '4294967296', ''])('rejects invalid amounts %s', (amount) => {
    expect(() => createUnitBillingModel(amount)).toThrow();
  });
  it.each([200, 201])('bills a completed HTTP %s without forecasts or token usage', (statusCode) => {
    expect(computeFinalUnitBilling(model, context, { ...response, statusCode })).toMatchObject({
      costUsdc: 5000n, usage: { quantity: 1 }, billingUsage: { version: 2, quantity: '1' },
    });
  });
  it.each([302, 400, 402, 429, 500, 503])('does not charge for HTTP %s', (statusCode) => {
    expect(computeFinalUnitBilling(model, context, { ...response, statusCode }).costUsdc).toBe(0n);
  });
  it('charges once regardless of the reported token or image count', () => {
    const body = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'ok' } }], data: [{ b64_json: 'image' }], usage: { prompt_tokens: 100000, completion_tokens: 10000 } }));
    expect(computeFinalUnitBilling(model, context, { ...response, body }).costUsdc).toBe(5000n);
    expect(captureUnitBillingContext({ ...context, request: { ...response, method: 'POST', path: '/v1/chat/completions' } }).requestUsage.quantity).toBe(1);
  });
  it('requires observed delivery, caps one call, and rejects overcharging without tolerance', () => {
    const report = { version: 2 as const, quantity: '1' };
    expect(() => validateUnitBillingUsage(model, context, report, 5000n, 1.5)).toThrow(/observed/);
    expect(() => validateUnitBillingUsage(model, context, report, 5000n, 1.5, { quantity: 0 })).toThrow();
    expect(() => validateUnitBillingUsage(model, context, { ...report, quantity: '2' }, 10000n, 1.5, { quantity: 1 })).toThrow();
    expect(() => validateUnitBillingUsage(model, context, report, 5001n, 1.5, { quantity: 1 })).toThrow(/exceeds/);
    expect(validateUnitBillingUsage(model, context, report, 5000n, 1.5, { quantity: 1 })).toBe(5000n);
    for (const count of [2, -1, 0.5, NaN]) expect(() => evaluateUnitBilling(model, context, { quantity: count })).toThrow();
  });
  it('rejects sub-micro prices, conditional tariffs, and duplicate components', () => {
    expect(validateUnitBillingModelV2({ version: 2, priceMicroUsdc: '0.1' })).not.toEqual([]);
    expect(validateUnitBillingModelV2({ ...model, components: [] })).not.toEqual([]);
    expect(validateUnitBillingModelV2({ ...model, match: { model: 'classifier' } })).not.toEqual([]);
  });
  it('exposes the per-call offer without treating it as free token inference', () => {
    const offers = buildNetworkServiceOffers([{ peerId: context.sellerPeerId, providers: ['openai'],
      providerPricing: { openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: { classifier: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } } },
      providerServiceApiProtocols: { openai: { services: { classifier: ['openai-chat-completions'] } } },
      providerServiceUnitBillingModels: { openai: { services: { classifier: { 'openai-chat-completions': model } } } },
    }]);
    expect(offers[0]?.billing).toEqual({ kind: 'per_quantity', amountMicroUsdc: '5000' });
    const tokenOffer = { ...offers[0]!, billing: undefined, inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
    expect(compareNetworkServiceOfferPrice(offers[0]!, tokenOffer)).toBeGreaterThan(0);
  });
});
