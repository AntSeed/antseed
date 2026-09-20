import type { ServiceApiProtocol } from './service-api.js';

export interface UnitBillingModelV2 {
  version: 2;
  priceMicroUsdc: string;
}

export type ServiceUnitBillingModelsV2 = Record<string, Partial<Record<ServiceApiProtocol, UnitBillingModelV2>>>;

export interface UnitBillingUsage {
  quantity: number;
}

export interface UnitBillingUsageReportV2 {
  version: 2;
  quantity: string;
}

export interface UnitBillingContext {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  maxQuantity?: number;
}

export const MAX_UNIT_PRICE_MICRO_USDC = 0xffff_ffffn;
export const FREE_UNIT_BILLING_MODEL_V2: UnitBillingModelV2 = { version: 2, priceMicroUsdc: '0' };

export function isQuantityBillingProtocol(protocol: string): boolean {
  return protocol === 'openai-images' || protocol === 'openai-chat-completions' || protocol === 'antseed-routing';
}

export function createUnitBillingModel(priceMicroUsdc: string): UnitBillingModelV2 {
  const model: UnitBillingModelV2 = { version: 2, priceMicroUsdc };
  const errors = validateUnitBillingModelV2(model);
  if (errors.length) throw new Error(errors.join('; '));
  return model;
}

export function unitPriceMicroUsdc(model: UnitBillingModelV2 | undefined): bigint | null {
  return model && validateUnitBillingModelV2(model).length === 0 ? BigInt(model.priceMicroUsdc) : null;
}

export function validateUnitBillingModelV2(model: unknown): string[] {
  if (!isObject(model) || model.version !== 2) return ['Unit billing model must be version 2; migrate legacy seller configuration'];
  if (Object.keys(model).some(key => !['version', 'priceMicroUsdc'].includes(key))) return ['Unsupported unit billing model field'];
  if (!isCanonicalInteger(model.priceMicroUsdc) || model.priceMicroUsdc.length > 10
    || BigInt(model.priceMicroUsdc) > MAX_UNIT_PRICE_MICRO_USDC) return ['priceMicroUsdc must be a canonical uint32 micro-USDC amount'];
  return [];
}

export function isFreeUnitBillingModel(model: UnitBillingModelV2): boolean {
  return unitPriceMicroUsdc(model) === 0n;
}

export function unitUsageToBillingReport(usage: UnitBillingUsage): UnitBillingUsageReportV2 {
  assertQuantity(usage.quantity);
  return { version: 2, quantity: String(usage.quantity) };
}

export function validateUnitBillingUsageReportV2(report: unknown): string[] {
  if (!isObject(report) || report.version !== 2) return ['Unit billing usage report must be version 2'];
  if (Object.keys(report).some(key => !['version', 'quantity'].includes(key))) return ['Unsupported unit billing usage field'];
  if (!isCanonicalInteger(report.quantity) || report.quantity.length > 16
    || BigInt(report.quantity) > BigInt(Number.MAX_SAFE_INTEGER)) return ['quantity must be a canonical safe non-negative integer decimal string'];
  return [];
}

export function unitUsageFromReport(report: UnitBillingUsageReportV2): UnitBillingUsage {
  const errors = validateUnitBillingUsageReportV2(report);
  if (errors.length) throw new Error(errors.join('; '));
  return { quantity: Number(report.quantity) };
}

export function evaluateUnitBilling(model: UnitBillingModelV2, context: UnitBillingContext, usage: UnitBillingUsage): bigint {
  const errors = validateUnitBillingModelV2(model);
  if (errors.length) throw new Error(errors.join('; '));
  validateQuantityWithinRequest(usage, context);
  return BigInt(model.priceMicroUsdc) * BigInt(usage.quantity);
}

export function validateUnitBillingUsage(
  model: UnitBillingModelV2,
  context: UnitBillingContext,
  report: UnitBillingUsageReportV2,
  sellerCost: bigint,
  _costToleranceMultiplier: number,
  observedUsage?: UnitBillingUsage,
): bigint {
  const usage = unitUsageFromReport(report);
  const buyerEstimate = evaluateUnitBilling(model, context, usage);
  if (observedUsage) {
    validateQuantityWithinRequest(observedUsage, context);
    if (usage.quantity > observedUsage.quantity) throw new Error('Seller quantity exceeds the quantity observed in the response');
  } else if (usage.quantity > 0 || sellerCost > 0n) {
    throw new Error('Unit billing quantity claimed before the buyer observed the delivered response');
  }
  if (sellerCost < 0n || sellerCost > buyerEstimate) throw new Error('Seller unit billing cost exceeds buyer estimate or is negative');
  return buyerEstimate;
}

export function usdToMicroUsdc(value: number): bigint {
  return BigInt(Math.max(0, Math.round(value * 1_000_000)));
}

function validateQuantityWithinRequest(usage: UnitBillingUsage, context: UnitBillingContext): void {
  if (!isQuantityBillingProtocol(context.serviceApiProtocol)) throw new Error('Unsupported quantity billing protocol');
  assertQuantity(usage.quantity);
  const maximum = context.serviceApiProtocol === 'openai-images' ? context.maxQuantity : Math.min(context.maxQuantity ?? 1, 1);
  if (maximum !== undefined) {
    assertQuantity(maximum);
    if (usage.quantity > maximum) throw new Error('Seller quantity exceeds the request limit');
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('quantity must be a safe non-negative integer');
}

function isCanonicalInteger(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
