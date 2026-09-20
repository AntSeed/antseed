import type { ServiceApiProtocol } from './service-api.js';

export interface UnitBillingComponentV2 {
  priceMicroUsdc: string;
  match?: Record<string, string>;
}

export interface UnitBillingModelV2 {
  version: 2;
  components: UnitBillingComponentV2[];
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
  attributes?: Record<string, string>;
}

export const MAX_UNIT_PRICE_MICRO_USDC = 0xffff_ffffn;
export const FREE_UNIT_BILLING_MODEL_V2: UnitBillingModelV2 = { version: 2, components: [] };

export function isQuantityBillingProtocol(protocol: string): boolean {
  return protocol === 'openai-images' || protocol === 'openai-chat-completions' || protocol === 'antseed-routing';
}

export function createUnitBillingModel(priceMicroUsdc: string): UnitBillingModelV2 {
  const model: UnitBillingModelV2 = { version: 2, components: [{ priceMicroUsdc }] };
  const errors = validateUnitBillingModelV2(model);
  if (errors.length) throw new Error(errors.join('; '));
  return model;
}

export function unitPriceMicroUsdc(model: UnitBillingModelV2 | undefined): bigint | null {
  if (!model || validateUnitBillingModelV2(model).length > 0
    || model.components.some(component => Object.keys(component.match ?? {}).length > 0)) return null;
  return model.components.reduce((total, component) => total + BigInt(component.priceMicroUsdc), 0n);
}

export function validateUnitBillingModelV2(model: unknown): string[] {
  if (!isObject(model) || model.version !== 2) return ['Unit billing model must be version 2; migrate legacy seller configuration'];
  if (Object.keys(model).some(key => !['version', 'components'].includes(key))) return ['Unsupported unit billing model field'];
  if (!Array.isArray(model.components) || model.components.length > 255) return ['components must be an array of at most 255 pricing components'];
  const errors: string[] = [];
  for (const [index, component] of model.components.entries()) {
    const field = `components[${index}]`;
    if (!isObject(component)) { errors.push(`${field} must be an object`); continue; }
    if (Object.keys(component).some(key => !['priceMicroUsdc', 'match'].includes(key))) errors.push(`${field}: unsupported component field`);
    if (!isCanonicalInteger(component.priceMicroUsdc) || component.priceMicroUsdc.length > 10
      || BigInt(component.priceMicroUsdc) > MAX_UNIT_PRICE_MICRO_USDC) errors.push(`${field}.priceMicroUsdc must be a canonical uint32 micro-USDC amount`);
    if (component.match !== undefined) {
      if (!isObject(component.match) || Object.keys(component.match).length > 255) {
        errors.push(`${field}.match must be an object with at most 255 conditions`);
      } else {
        for (const [key, value] of Object.entries(component.match)) {
          if (!key || new TextEncoder().encode(key).length > 255 || typeof value !== 'string' || !value.length
            || new TextEncoder().encode(value).length > 255) errors.push(`${field}.match: conditions must have nonempty UTF-8 keys and string values of at most 255 bytes`);
        }
      }
    }
  }
  return errors;
}

export function resolveUnitPriceMicroUsdc(model: UnitBillingModelV2, context: Pick<UnitBillingContext, 'attributes'>): bigint {
  const errors = validateUnitBillingModelV2(model);
  if (errors.length) throw new Error(errors.join('; '));
  const matched = model.components.filter(component => Object.entries(component.match ?? {})
    .every(([key, value]) => Object.hasOwn(context.attributes ?? {}, key) && context.attributes![key] === value));
  if (model.components.length > 0 && matched.length === 0) throw new Error('No billing component matched the request attributes');
  return matched.reduce((total, component) => total + BigInt(component.priceMicroUsdc), 0n);
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
  return usage.quantity === 0 ? 0n : resolveUnitPriceMicroUsdc(model, context) * BigInt(usage.quantity);
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
