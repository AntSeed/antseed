import { describe, expect, it } from 'vitest';
import {
  completedRequestBillingModel, evaluateUnitBilling, parseMicroUsdc,
  unitUsageFromReport, unitUsageToBillingReport, validateUnitBillingModel,
  validateUnitBillingModelV1, validateUnitBillingUsage, validateUnitBillingUsageReport,
  type UnitBillingContext, type UnitBillingModel, type UnitBillingModelV1, type UnitBillingUsageReport,
} from './billing.js';

const context: UnitBillingContext = {
  sellerPeerId: 'a'.repeat(40), provider: 'router', service: 'route',
  serviceApiProtocol: 'levanto-routing', unitLimits: { completed_requests: 1 },
};

describe('shared unit billing', () => {
  it.each(['0', '1', '1000', '9007199254740991'])('computes %s micro-USDC exactly', price => {
    const model = completedRequestBillingModel(price);
    expect(evaluateUnitBilling(model, context, { units: { completed_requests: 1 } })).toBe(BigInt(price));
    expect(evaluateUnitBilling(model, context, { units: { completed_requests: 0 } })).toBe(0n);
  });
  it.each([undefined, null, 1000, '01', '-1', '0.1', '1e3', '9007199254740992'])('rejects malformed price %s', price => {
    expect(() => parseMicroUsdc(price as string)).toThrow();
  });
  it('preserves image v1 calculation and report shapes', () => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };
    const usage = { units: { output_images: 2 } };
    expect(evaluateUnitBilling(model, { ...context, serviceApiProtocol: 'openai-images' }, usage)).toBe(80000n);
    expect(unitUsageToBillingReport(usage)).toEqual({ version: 1, units: { output_images: '2' } });
    expect(validateUnitBillingModelV1({ version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } as unknown as UnitBillingModelV1)).not.toEqual([]);
  });
  it.each([{}, { version: 2, components: [] }, { version: 2, components: [{ unit: 'output_images', priceMicroUsdc: '1000' }] }, { version: 2, components: [{ unit: 'completed_requests', priceMicroUsdc: 1000 }] }])('rejects invalid models %j', model => {
    expect(validateUnitBillingModel(model as UnitBillingModel)).not.toEqual([]);
  });
  it.each([{}, { version: 1, units: { completed_requests: '1' } }, { version: 2, units: { output_images: '1' } }, { version: 2, units: { completed_requests: '2' } }, { version: 2, units: { completed_requests: 1 } }, { version: 2, units: { completed_requests: '1', output_images: '1' } }])('rejects malformed reports %j', report => {
    expect(validateUnitBillingUsageReport(report as UnitBillingUsageReport)).not.toEqual([]);
    expect(() => unitUsageFromReport(report as UnitBillingUsageReport)).toThrow();
  });
  it('enforces observed usage, request limits, report version and exact price', () => {
    const model = completedRequestBillingModel('1000');
    const usage = { units: { completed_requests: 1 } };
    const report = unitUsageToBillingReport(usage);
    expect(validateUnitBillingUsage(model, context, report, 1000n, 1.4, usage)).toBe(1000n);
    for (const cost of [999n, 1001n]) expect(() => validateUnitBillingUsage(model, context, report, cost, 1.4, usage)).toThrow();
    expect(() => validateUnitBillingUsage(model, context, report, 1000n, 1.4)).toThrow('observed');
    expect(() => validateUnitBillingUsage(model, context, { version: 1, units: { output_images: '1' } }, 1000n, 1.4, usage)).toThrow('model');
    expect(() => evaluateUnitBilling(model, { ...context, unitLimits: { completed_requests: 0 } }, usage)).toThrow();
    expect(() => evaluateUnitBilling(model, context, { units: { completed_requests: 2 } })).toThrow();
    expect(() => unitUsageToBillingReport({ units: { completed_requests: 1, output_images: 1 } })).toThrow();
  });
});
