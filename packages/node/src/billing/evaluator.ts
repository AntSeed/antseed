import type {
  BillingComponentV1,
  BillingMatchKeyV1,
  BillingMeterV1,
  BillingUsageReportV1,
  NormalizedUsage,
  ServiceBillingModelV1,
} from "../types/billing.js";
import {
  isBillingMatchKeyV1,
  isBillingMeterV1,
  isTokenBillingMeterV1,
  isUnitBillingMeterV1,
  isValidBillingComponentV1,
} from "../types/billing.js";

export interface BillingEvaluationAppliedComponent {
  component: BillingComponentV1;
  meterCount: number;
  costUsdc: bigint;
}

export interface BillingEvaluationResult {
  costUsdc: bigint;
  appliedComponents: BillingEvaluationAppliedComponent[];
}

export function validateServiceBillingModelV1(model: ServiceBillingModelV1): string[] {
  const errors: string[] = [];
  if (!model || typeof model !== "object" || model.version !== 1 || !Array.isArray(model.components)) {
    return ["Billing model must be version 1 with a components array"];
  }
  model.components.forEach((component, index) => {
    if (!component || typeof component !== "object") {
      errors.push(`components[${index}] must be an object`);
      return;
    }
    if (!isBillingMeterV1(component.meter)) {
      errors.push(`components[${index}].meter is unsupported`);
    }
    if (!isValidBillingComponentV1(component)) {
      if (isTokenBillingMeterV1(component.meter) && component.unit !== "per_million") {
        errors.push(`components[${index}].unit must be per_million for token meters`);
      } else if (isUnitBillingMeterV1(component.meter) && component.unit !== "per_unit") {
        errors.push(`components[${index}].unit must be per_unit for unit meters`);
      } else {
        errors.push(`components[${index}] has an invalid meter/unit combination`);
      }
    }
    if (!Number.isFinite(component.priceUsd) || component.priceUsd < 0) {
      errors.push(`components[${index}].priceUsd must be a non-negative finite number`);
    }
    if (component.match !== undefined) {
      if (!component.match || typeof component.match !== "object" || Array.isArray(component.match)) {
        errors.push(`components[${index}].match must be an object`);
      } else {
        for (const [key, value] of Object.entries(component.match)) {
          if (!isBillingMatchKeyV1(key)) {
            errors.push(`components[${index}].match.${key} is unsupported`);
          }
          if (typeof value !== "string" || value.length === 0) {
            errors.push(`components[${index}].match.${key} must be a non-empty string`);
          }
        }
      }
    }
  });
  return errors;
}

export function isFreeBillingModel(model: ServiceBillingModelV1): boolean {
  return model.components.length === 0
    || model.components.every((component) => Number.isFinite(component.priceUsd) && component.priceUsd <= 0);
}

export function evaluateBillingModel(
  model: ServiceBillingModelV1,
  usage: NormalizedUsage,
): BillingEvaluationResult {
  const validationErrors = validateServiceBillingModelV1(model);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid service billing model: ${validationErrors.join("; ")}`);
  }

  let totalUsd = 0;
  const appliedComponents: BillingEvaluationAppliedComponent[] = [];
  for (const component of model.components) {
    const meterCount = normalizedMeterCount(usage, component.meter);
    if (meterCount <= 0) continue;
    if (!componentMatchesUsage(component, usage)) continue;

    const componentUsd = component.unit === "per_million"
      ? (meterCount * component.priceUsd) / 1_000_000
      : meterCount * component.priceUsd;
    const costUsdc = usdToMicroUsdc(componentUsd);
    totalUsd += componentUsd;
    appliedComponents.push({ component, meterCount, costUsdc });
  }

  return {
    costUsdc: usdToMicroUsdc(totalUsd),
    appliedComponents,
  };
}

export function usageFromBillingReport(
  report: BillingUsageReportV1,
  trustedContext?: Pick<NormalizedUsage, "attributes" | "meterAttributes">,
): NormalizedUsage {
  const meters: Partial<Record<BillingMeterV1, number>> = {};
  for (const [meter, value] of Object.entries(report.meters)) {
    if (!isBillingMeterV1(meter)) continue;
    meters[meter] = parseBillingMeterCount(value, meter);
  }
  return {
    meters,
    ...(trustedContext?.attributes ? { attributes: trustedContext.attributes } : {}),
    ...(trustedContext?.meterAttributes ? { meterAttributes: trustedContext.meterAttributes } : {}),
  };
}

export function validateBillingUsageReportV1(report: BillingUsageReportV1): string[] {
  const errors: string[] = [];
  if (!report || typeof report !== "object" || report.version !== 1) {
    return ["Billing usage report must be version 1"];
  }
  if (!report.meters || typeof report.meters !== "object" || Array.isArray(report.meters)) {
    errors.push("meters must be an object");
  } else {
    for (const [meter, value] of Object.entries(report.meters)) {
      if (!isBillingMeterV1(meter)) errors.push(`Unsupported billing meter "${meter}"`);
      if (typeof value !== "string") {
        errors.push(`Meter "${meter}" must be encoded as a string`);
      } else {
        try {
          parseBillingMeterCount(value, meter);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : `Meter "${meter}" must be a safe non-negative integer decimal string`);
        }
      }
    }
  }
  if (typeof report.costUsdc !== "string") {
    errors.push("costUsdc must be a string");
  } else {
    try {
      if (BigInt(report.costUsdc) < 0n) errors.push("costUsdc must be non-negative");
    } catch {
      errors.push("costUsdc must be a base-unit integer string");
    }
  }
  validateAttributeMap(errors, "attributes", report.attributes);
  if (report.meterAttributes !== undefined) {
    if (!report.meterAttributes || typeof report.meterAttributes !== "object" || Array.isArray(report.meterAttributes)) {
      errors.push("meterAttributes must be an object");
    } else {
      for (const [meter, attrs] of Object.entries(report.meterAttributes)) {
        if (!isBillingMeterV1(meter)) errors.push(`Unsupported meterAttributes meter "${meter}"`);
        validateAttributeMap(errors, `meterAttributes.${meter}`, attrs);
      }
    }
  }
  return errors;
}

function parseBillingMeterCount(value: string, meter: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Meter "${meter}" must be a canonical non-negative integer decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Meter "${meter}" exceeds the maximum safe integer`);
  }
  return Number(parsed);
}

function normalizedMeterCount(usage: NormalizedUsage, meter: BillingMeterV1): number {
  const value = usage.meters[meter] ?? 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function componentMatchesUsage(component: BillingComponentV1, usage: NormalizedUsage): boolean {
  const match = component.match;
  if (!match || Object.keys(match).length === 0) return true;
  const meterAttrs = usage.meterAttributes?.[component.meter] ?? {};
  const requestAttrs = usage.attributes ?? {};
  for (const [key, expected] of Object.entries(match) as Array<[BillingMatchKeyV1, string]>) {
    const actual = meterAttrs[key] ?? requestAttrs[key];
    if (actual !== expected) return false;
  }
  return true;
}

function validateAttributeMap(
  errors: string[],
  field: string,
  value: Partial<Record<BillingMatchKeyV1, string>> | undefined,
): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field} must be an object`);
    return;
  }
  for (const [key, attr] of Object.entries(value)) {
    if (!isBillingMatchKeyV1(key)) errors.push(`${field}.${key} is unsupported`);
    if (typeof attr !== "string" || attr.length === 0) {
      errors.push(`${field}.${key} must be a non-empty string`);
    }
  }
}

export function usdToMicroUsdc(value: number): bigint {
  return BigInt(Math.max(0, Math.round(value * 1_000_000)));
}
