import type { ServiceApiProtocol } from "./service-api.js";

export const UNIT_BILLING_UNITS_V1 = [
  "output_images",
] as const;

export const UNIT_BILLING_MATCH_KEYS_V1 = [
  "model",
  "size",
  "quality",
  "resolution",
] as const;

export type UnitBillingUnitV1 = (typeof UNIT_BILLING_UNITS_V1)[number];
export type UnitBillingMatchKeyV1 = (typeof UNIT_BILLING_MATCH_KEYS_V1)[number];

export interface UnitBillingComponentV1 {
  unit: UnitBillingUnitV1;
  priceUsd: number;
  match?: Partial<Record<UnitBillingMatchKeyV1, string>>;
}

export interface UnitBillingModelV1 {
  version: 1;
  components: UnitBillingComponentV1[];
}

export type ServiceUnitBillingModelsV1 = Record<
  string,
  Partial<Record<ServiceApiProtocol, UnitBillingModelV1>>
>;

/**
 * Canonical non-token usage consumed by unit billing.
 * Token pricing stays on the TokenUsage + computeCostUsdc path.
 */
export interface UnitBillingUsage {
  units: Partial<Record<UnitBillingUnitV1, number>>;
}

/**
 * Compact unit billing evidence carried in NeedAuth.
 * Buyers recompute cost from this report plus their trusted UnitBillingContext.
 */
export interface UnitBillingUsageReportV1 {
  version: 1;
  units: Partial<Record<UnitBillingUnitV1, string>>;
}

export interface UnitBillingContext {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  attributes?: Partial<Record<UnitBillingMatchKeyV1, string>>;
  unitLimits?: Partial<Record<UnitBillingUnitV1, number>>;
}

export const GENERATED_IMAGE_OUTPUT_UNIT_V1 = "output_images" satisfies UnitBillingUnitV1;

export const FREE_UNIT_BILLING_MODEL_V1: UnitBillingModelV1 = {
  version: 1,
  components: [],
};

export const UNIT_BILLING_UNIT_SET_V1 = new Set<string>(UNIT_BILLING_UNITS_V1);
export const UNIT_BILLING_MATCH_KEY_SET_V1 = new Set<string>(UNIT_BILLING_MATCH_KEYS_V1);

export function isUnitBillingUnitV1(value: string): value is UnitBillingUnitV1 {
  return UNIT_BILLING_UNIT_SET_V1.has(value);
}

export function isUnitBillingMatchKeyV1(value: string): value is UnitBillingMatchKeyV1 {
  return UNIT_BILLING_MATCH_KEY_SET_V1.has(value);
}

export function isValidUnitBillingComponentV1(component: UnitBillingComponentV1): boolean {
  return isUnitBillingUnitV1(component.unit);
}

export function unitUsageToBillingReport(
  usage: UnitBillingUsage,
): UnitBillingUsageReportV1 {
  const units: Partial<Record<UnitBillingUnitV1, string>> = {};
  for (const [unit, count] of Object.entries(usage.units)) {
    if (!isUnitBillingUnitV1(unit) || count === undefined) continue;
    units[unit] = String(count);
  }
  return {
    version: 1,
    units,
  };
}
