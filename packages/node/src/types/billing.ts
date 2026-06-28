import type { ServiceApiProtocol } from "./service-api.js";

export const TOKEN_BILLING_METERS_V1 = [
  "text_input_tokens",
  "cached_text_input_tokens",
  "output_text_tokens",
] as const;

export const UNIT_BILLING_METERS_V1 = [
  "output_images",
] as const;

export const BILLING_MATCH_KEYS_V1 = [
  "model",
  "size",
  "quality",
  "resolution",
] as const;

export const BILLING_UNITS_V1 = ["per_million", "per_unit"] as const;

export type TokenBillingMeterV1 = (typeof TOKEN_BILLING_METERS_V1)[number];
export type UnitBillingMeterV1 = (typeof UNIT_BILLING_METERS_V1)[number];
export type BillingMeterV1 = TokenBillingMeterV1 | UnitBillingMeterV1;
export type BillingMatchKeyV1 = (typeof BILLING_MATCH_KEYS_V1)[number];
export type BillingUnitV1 = (typeof BILLING_UNITS_V1)[number];

export type BillingComponentV1 =
  | {
      meter: TokenBillingMeterV1;
      unit: "per_million";
      priceUsd: number;
      match?: Partial<Record<BillingMatchKeyV1, string>>;
    }
  | {
      meter: UnitBillingMeterV1;
      unit: "per_unit";
      priceUsd: number;
      match?: Partial<Record<BillingMatchKeyV1, string>>;
    };

export interface ServiceBillingModelV1 {
  version: 1;
  components: BillingComponentV1[];
}

export type ServiceBillingModelsV1 = Record<
  string,
  Partial<Record<ServiceApiProtocol, ServiceBillingModelV1>>
>;

/**
 * Canonical billable usage consumed by the billing evaluator.
 *
 * Adapter-level request/response facts are normalized into this shape before
 * pricing. Token-only v10 pricing is represented as token meters, while image
 * generation uses output_images plus request-owned match attributes such as
 * size, quality, and resolution.
 */
export interface NormalizedUsage {
  meters: Partial<Record<BillingMeterV1, number>>;
  attributes?: Partial<Record<BillingMatchKeyV1, string>>;
  meterAttributes?: Partial<Record<BillingMeterV1, Partial<Record<BillingMatchKeyV1, string>>>>;
}

/**
 * Compact billing evidence carried in NeedAuth.
 *
 * Counts are strings because payment messages are serialized over the wire and
 * validated before conversion. Buyers recompute the cost from this report plus
 * their trusted BuyerRequestBillingContext before signing more spend.
 */
export interface BillingUsageReportV1 {
  version: 1;
  meters: Partial<Record<BillingMeterV1, string>>;
  attributes?: Partial<Record<BillingMatchKeyV1, string>>;
  meterAttributes?: Partial<Record<BillingMeterV1, Partial<Record<BillingMatchKeyV1, string>>>>;
  costUsdc: string;
}

export interface BuyerRequestBillingContext {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  attributes?: Partial<Record<BillingMatchKeyV1, string>>;
  meterAttributes?: Partial<Record<BillingMeterV1, Partial<Record<BillingMatchKeyV1, string>>>>;
}

export const GENERATED_IMAGE_OUTPUT_BILLING_METER_V1 = "output_images" satisfies UnitBillingMeterV1;

export const FREE_SERVICE_BILLING_MODEL_V1: ServiceBillingModelV1 = {
  version: 1,
  components: [],
};

export const TOKEN_BILLING_METER_SET_V1 = new Set<string>(TOKEN_BILLING_METERS_V1);
export const UNIT_BILLING_METER_SET_V1 = new Set<string>(UNIT_BILLING_METERS_V1);
export const BILLING_METER_SET_V1 = new Set<string>([
  ...TOKEN_BILLING_METERS_V1,
  ...UNIT_BILLING_METERS_V1,
]);
export const BILLING_MATCH_KEY_SET_V1 = new Set<string>(BILLING_MATCH_KEYS_V1);
export const BILLING_UNIT_SET_V1 = new Set<string>(BILLING_UNITS_V1);

export function isTokenBillingMeterV1(value: string): value is TokenBillingMeterV1 {
  return TOKEN_BILLING_METER_SET_V1.has(value);
}

export function isUnitBillingMeterV1(value: string): value is UnitBillingMeterV1 {
  return UNIT_BILLING_METER_SET_V1.has(value);
}

export function isBillingMeterV1(value: string): value is BillingMeterV1 {
  return BILLING_METER_SET_V1.has(value);
}

export function isBillingMatchKeyV1(value: string): value is BillingMatchKeyV1 {
  return BILLING_MATCH_KEY_SET_V1.has(value);
}

export function isValidBillingComponentV1(component: BillingComponentV1): boolean {
  return (isTokenBillingMeterV1(component.meter) && component.unit === "per_million")
    || (isUnitBillingMeterV1(component.meter) && component.unit === "per_unit");
}

export function normalizedUsageToBillingReport(
  usage: NormalizedUsage,
  costUsdc: bigint,
): BillingUsageReportV1 {
  const meters: Partial<Record<BillingMeterV1, string>> = {};
  for (const [meter, count] of Object.entries(usage.meters)) {
    if (!isBillingMeterV1(meter) || count === undefined) continue;
    meters[meter] = String(count);
  }
  return {
    version: 1,
    meters,
    ...(usage.attributes ? { attributes: usage.attributes } : {}),
    ...(usage.meterAttributes ? { meterAttributes: usage.meterAttributes } : {}),
    costUsdc: costUsdc.toString(),
  };
}
