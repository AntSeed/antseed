import { describe, expect, it } from 'vitest';
import { createUnitBillingModel, evaluateUnitBilling, validateUnitBillingModelV2, validateUnitBillingUsage, validateUnitBillingUsageReportV2, type UnitBillingContext } from './billing.js';

const context: UnitBillingContext = { sellerPeerId: 'seller', provider: 'provider', service: 'service', serviceApiProtocol: 'openai-images', maxQuantity: 4 };

describe('quantity billing v2', () => {
  it.each(['0', '1', '5000', '16777217', '4294967295'])('multiplies exact micro-USDC price %s', amount => {
    expect(evaluateUnitBilling(createUnitBillingModel(amount), context, { quantity: 4 })).toBe(BigInt(amount) * 4n);
  });
  it.each(['-1', '01', '1.5', '1e3', '4294967296', '', '9'.repeat(1000)])('rejects invalid price %s', amount => {
    expect(() => createUnitBillingModel(amount)).toThrow();
  });
  it('rejects legacy and additional billing fields', () => {
    expect(validateUnitBillingModelV2({ version: 1, components: [] })).not.toEqual([]);
    expect(validateUnitBillingModelV2({ version: 2, priceMicroUsdc: '1', unit: 'image' })).not.toEqual([]);
    expect(validateUnitBillingUsageReportV2({ version: 1, units: {} })).not.toEqual([]);
    expect(validateUnitBillingUsageReportV2({ version: 2, quantity: '1', units: {} })).not.toEqual([]);
  });
  it.each(['01', '-1', '1.5', '1e3', '9007199254740992', '', '9'.repeat(1000)])('rejects invalid quantity %s', quantity => {
    expect(validateUnitBillingUsageReportV2({ version: 2, quantity })).not.toEqual([]);
  });
  it('requires observed fulfillment and caps claims to the request and response', () => {
    const model = createUnitBillingModel('40000');
    const report = { version: 2 as const, quantity: '2' };
    expect(() => validateUnitBillingUsage(model, context, report, 80000n, 1.4)).toThrow('observed');
    expect(() => validateUnitBillingUsage(model, context, report, 80000n, 1.4, { quantity: 1 })).toThrow('observed');
    expect(() => validateUnitBillingUsage(model, { ...context, maxQuantity: 1 }, report, 80000n, 1.4, { quantity: 2 })).toThrow('limit');
    expect(() => validateUnitBillingUsage(model, context, report, 80001n, 1.4, { quantity: 2 })).toThrow('exceeds');
    expect(validateUnitBillingUsage(model, context, report, 80000n, 1.4, { quantity: 2 })).toBe(80000n);
  });
  it('limits request-counted adapters to one result', () => {
    expect(() => evaluateUnitBilling(createUnitBillingModel('1'), { ...context, serviceApiProtocol: 'antseed-routing' }, { quantity: 2 })).toThrow('limit');
  });
});
