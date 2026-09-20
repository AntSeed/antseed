import { describe, expect, it } from 'vitest';
import { createUnitBillingModel, evaluateUnitBilling, isFreeUnitBillingModel, resolveUnitPriceMicroUsdc, unitPriceMicroUsdc, validateUnitBillingModelV2, validateUnitBillingUsage, validateUnitBillingUsageReportV2, type UnitBillingContext, type UnitBillingModelV2 } from './billing.js';

const context: UnitBillingContext = { sellerPeerId: 'seller', provider: 'provider', service: 'service', serviceApiProtocol: 'openai-images', maxQuantity: 4 };

describe('quantity billing v2', () => {
  const conditional: UnitBillingModelV2 = { version: 2, components: [
    { priceMicroUsdc: '40000', match: { quality: 'standard' } },
    { priceMicroUsdc: '80000', match: { quality: 'hd' } },
    { priceMicroUsdc: '20000', match: { quality: 'hd', size: '1536x1024' } },
  ] };
  it('adds all matching components and multiplies independently measured quantity', () => {
    const captured = { ...context, attributes: { quality: 'hd', size: '1536x1024' } };
    expect(evaluateUnitBilling(conditional, captured, { quantity: 3 })).toBe(300000n);
    expect(evaluateUnitBilling({ ...conditional, components: [...conditional.components].reverse() }, captured, { quantity: 3 })).toBe(300000n);
    expect(resolveUnitPriceMicroUsdc(conditional, { attributes: { quality: 'hd' } })).toBe(80000n);
    expect(resolveUnitPriceMicroUsdc(conditional, { attributes: { quality: 'standard', size: '1536x1024' } })).toBe(40000n);
    expect(unitPriceMicroUsdc(conditional)).toBeNull();
  });
  it('requires every condition and rejects unmatched positive usage', () => {
    expect(() => resolveUnitPriceMicroUsdc(conditional, {})).toThrow('No billing component matched');
    expect(() => evaluateUnitBilling(conditional, context, { quantity: 1 })).toThrow('No billing component matched');
    expect(evaluateUnitBilling(conditional, context, { quantity: 0 })).toBe(0n);
  });
  it('supports free models without making conditional free rules universal', () => {
    expect(isFreeUnitBillingModel({ version: 2, components: [] })).toBe(true);
    expect(evaluateUnitBilling({ version: 2, components: [] }, context, { quantity: 2 })).toBe(0n);
    const free: UnitBillingModelV2 = { version: 2, components: [{ priceMicroUsdc: '0', match: { quality: 'standard' } }] };
    expect(isFreeUnitBillingModel(free)).toBe(false);
    expect(() => resolveUnitPriceMicroUsdc(free, {})).toThrow('No billing component matched');
  });
  it('sums unconditional components and surcharges without uint32 truncation', () => {
    const model: UnitBillingModelV2 = { version: 2, components: [{ priceMicroUsdc: '4294967295' }, { priceMicroUsdc: '4294967295', match: {} }] };
    expect(unitPriceMicroUsdc(model)).toBe(8589934590n);
    expect(evaluateUnitBilling(model, context, { quantity: 4 })).toBe(34359738360n);
    expect(resolveUnitPriceMicroUsdc({ version: 2, components: [{ priceMicroUsdc: '1' }, ...conditional.components] }, { attributes: { quality: 'hd' } })).toBe(80001n);
  });
  it('verifies the request price rather than the seller-selected condition', () => {
    const captured = { ...context, attributes: { quality: 'standard' } };
    expect(() => validateUnitBillingUsage(conditional, captured, { version: 2, quantity: '1' }, 80000n, 1.4, { quantity: 1 })).toThrow('exceeds');
    expect(validateUnitBillingUsage(conditional, captured, { version: 2, quantity: '1' }, 40000n, 1.4, { quantity: 1 })).toBe(40000n);
  });
  it.each([
    { version: 2, priceMicroUsdc: '1' },
    { version: 2, components: Array.from({ length: 256 }, () => ({ priceMicroUsdc: '0' })) },
    { version: 2, components: [{ priceMicroUsdc: '1', unit: 'image' }] },
    { version: 2, components: [{ priceMicroUsdc: '1', match: { quality: '' } }] },
    { version: 2, components: [{ priceMicroUsdc: '1', match: { quality: 'é'.repeat(128) } }] },
    { version: 2, components: [{ priceMicroUsdc: '1', match: { quality: 1 } }] },
    { version: 2, components: [{ priceMicroUsdc: '1', match: [] }] },
  ])('rejects malformed or oversized component models', model => {
    expect(validateUnitBillingModelV2(model).length).toBeGreaterThan(0);
  });
  it.each(['0', '1', '5000', '16777217', '4294967295'])('multiplies exact micro-USDC price %s', amount => {
    expect(evaluateUnitBilling(createUnitBillingModel(amount), context, { quantity: 4 })).toBe(BigInt(amount) * 4n);
  });
  it.each(['-1', '01', '1.5', '1e3', '4294967296', '', '9'.repeat(1000)])('rejects invalid price %s', amount => {
    expect(() => createUnitBillingModel(amount)).toThrow();
  });
  it('rejects legacy and additional billing fields', () => {
    expect(validateUnitBillingModelV2({ version: 1, components: [] })).not.toEqual([]);
    expect(validateUnitBillingModelV2({ version: 2, components: [{ priceMicroUsdc: '1' }], unit: 'image' })).not.toEqual([]);
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
