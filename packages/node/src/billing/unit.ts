import type {
  ImageRequestFacts,
  ProviderResponseFacts,
  TokenUsage,
} from "@antseed/api-adapter";
import {
  extractImageRequestFacts,
  extractProviderResponseFacts,
  extractRequestBodyFields,
  parseJsonObject,
} from "@antseed/api-adapter";
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
} from "../types/http.js";
import type {
  UnitBillingComponentV1,
  UnitBillingContext,
  UnitBillingMatchKeyV1,
  UnitBillingModelV1,
  UnitBillingUnitV1,
  UnitBillingUsage,
  UnitBillingUsageReportV1,
} from "../types/billing.js";
import {
  isUnitBillingMatchKeyV1,
  isUnitBillingUnitV1,
  isValidUnitBillingComponentV1,
  unitUsageToBillingReport,
} from "../types/billing.js";
import type { ServiceApiProtocol } from "../types/service-api.js";

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  freshInputTokens: 0,
  cachedInputTokens: 0,
};

export interface CapturedUnitBillingContext {
  /** Trusted identity + request attributes used later to validate unit billing. */
  context: UnitBillingContext;
  /** Request-known unit limit for seller preflight, not final delivered usage. */
  requestUsage: UnitBillingUsage;
  /** API-shape request facts reused when final response usage is normalized. */
  requestFacts: ImageRequestFacts;
}

export interface FinalUnitBillingResult {
  usage: UnitBillingUsage;
  tokenUsage: TokenUsage;
  costUsdc: bigint;
  billingUsage: UnitBillingUsageReportV1;
}

export function validateUnitBillingModelV1(model: UnitBillingModelV1): string[] {
  const errors: string[] = [];
  if (!model || typeof model !== "object" || model.version !== 1 || !Array.isArray(model.components)) {
    return ["Unit billing model must be version 1 with a components array"];
  }
  model.components.forEach((component, index) => {
    if (!component || typeof component !== "object") {
      errors.push(`components[${index}] must be an object`);
      return;
    }
    if (!isUnitBillingUnitV1(component.unit)) {
      errors.push(`components[${index}].unit is unsupported`);
    }
    if (!isValidUnitBillingComponentV1(component)) {
      errors.push(`components[${index}] must use a supported unit`);
    }
    if (!Number.isFinite(component.priceUsd) || component.priceUsd < 0) {
      errors.push(`components[${index}].priceUsd must be a non-negative finite number`);
    }
    if (component.match !== undefined) {
      if (!component.match || typeof component.match !== "object" || Array.isArray(component.match)) {
        errors.push(`components[${index}].match must be an object`);
      } else {
        for (const [key, value] of Object.entries(component.match)) {
          if (!isUnitBillingMatchKeyV1(key)) {
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

export function isFreeUnitBillingModel(model: UnitBillingModelV1): boolean {
  return model.components.length === 0
    || model.components.every((component) => Number.isFinite(component.priceUsd) && component.priceUsd <= 0);
}

export function evaluateUnitBilling(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  usage: UnitBillingUsage,
): bigint {
  const validationErrors = validateUnitBillingModelV1(model);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid unit billing model: ${validationErrors.join("; ")}`);
  }

  let totalUsd = 0;
  for (const component of model.components) {
    const unitCount = normalizedUnitCount(usage, component.unit);
    if (unitCount <= 0) continue;
    if (!componentMatchesContext(component, context)) continue;

    totalUsd += unitCount * component.priceUsd;
  }

  return usdToMicroUsdc(totalUsd);
}

export function captureUnitBillingContext(args: {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  request: SerializedHttpRequest;
}): CapturedUnitBillingContext {
  const parsed = extractRequestBodyFields(args.request.headers, args.request.body);
  const requestFacts = extractImageRequestFacts({
    path: args.request.path,
    method: args.request.method,
    body: parsed ?? undefined,
  });
  const requestUsage = factsToUnitUsage(requestFacts);
  const attributes = factsToAttributes(requestFacts);
  return {
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      ...(attributes ? { attributes } : {}),
      ...(requestFacts.requestedImages !== undefined
        ? { unitLimits: { output_images: requestFacts.requestedImages } }
        : {}),
    },
    requestUsage,
    requestFacts,
  };
}

export function extractUnitResponseUsage(
  response: SerializedHttpResponse,
  requestFacts?: ImageRequestFacts,
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  const parsed = parseJsonObject(response.body);
  const responseFacts: ProviderResponseFacts = parsed
    ? extractProviderResponseFacts(parsed)
    : { tokenUsage: ZERO_TOKEN_USAGE };
  const billableOutputImages = capOutputImagesToRequest(
    responseFacts.outputImages,
    requestFacts?.requestedImages,
  );
  return {
    usage: {
      units: {
        ...(billableOutputImages !== undefined ? { output_images: billableOutputImages } : {}),
      },
    },
    tokenUsage: responseFacts.tokenUsage,
  };
}

export function computeFinalUnitBilling(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  response: SerializedHttpResponse,
  requestFacts?: ImageRequestFacts,
): FinalUnitBillingResult {
  const responseUsage = extractUnitResponseUsage(response, requestFacts);
  const costUsdc = evaluateUnitBilling(model, context, responseUsage.usage);
  return {
    usage: responseUsage.usage,
    tokenUsage: responseUsage.tokenUsage,
    costUsdc,
    billingUsage: unitUsageToBillingReport(responseUsage.usage),
  };
}

export function validateUnitBillingUsageReportV1(report: UnitBillingUsageReportV1): string[] {
  const errors: string[] = [];
  if (!report || typeof report !== "object" || report.version !== 1) {
    return ["Unit billing usage report must be version 1"];
  }
  if (!report.units || typeof report.units !== "object" || Array.isArray(report.units)) {
    errors.push("units must be an object");
  } else {
    for (const [unit, value] of Object.entries(report.units)) {
      if (!isUnitBillingUnitV1(unit)) errors.push(`Unsupported billing unit "${unit}"`);
      if (typeof value !== "string") {
        errors.push(`Unit "${unit}" must be encoded as a string`);
      } else {
        try {
          parseUnitCount(value, unit);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : `Unit "${unit}" must be a safe non-negative integer decimal string`);
        }
      }
    }
  }
  return errors;
}

export function unitUsageFromReport(report: UnitBillingUsageReportV1): UnitBillingUsage {
  const units: Partial<Record<UnitBillingUnitV1, number>> = {};
  for (const [unit, value] of Object.entries(report.units)) {
    if (!isUnitBillingUnitV1(unit)) continue;
    units[unit] = parseUnitCount(value, unit);
  }
  return { units };
}

export function validateUnitBillingUsage(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  report: UnitBillingUsageReportV1,
  sellerCost: bigint,
  costToleranceMultiplier: number,
  observedUsage?: UnitBillingUsage,
): bigint {
  const errors = validateUnitBillingUsageReportV1(report);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  const usage = unitUsageFromReport(report);
  validateUsageWithinRequestLimits(usage, context);
  if (observedUsage) {
    validateUsageWithinObservedUsage(usage, observedUsage);
  } else if (sellerCost > 0n) {
    // Fail closed: without observed usage a seller could claim delivery before
    // the buyer received anything and get paid for undelivered units. The buyer
    // signs a post-response SpendingAuth once the response arrives, so a
    // legitimate seller loses nothing by this rejection.
    throw new Error("Positive unit billing cost claimed before the buyer observed the delivered response");
  }
  const buyerEstimate = evaluateUnitBilling(model, context, usage);
  if (sellerCost > 0n && buyerEstimate <= 0n) {
    throw new Error("Positive unit billing cost recomputed to zero");
  }

  const maxAcceptable = BigInt(
    Math.ceil(Number(buyerEstimate) * costToleranceMultiplier),
  );
  if (sellerCost > maxAcceptable) {
    throw new Error(
      `Seller unit billing cost ${sellerCost} exceeds buyer estimate ${buyerEstimate}`,
    );
  }
  return sellerCost;
}

export function usdToMicroUsdc(value: number): bigint {
  return BigInt(Math.max(0, Math.round(value * 1_000_000)));
}

function factsToUnitUsage(facts: ImageRequestFacts): UnitBillingUsage {
  return {
    units: {
      ...(facts.requestedImages !== undefined ? { output_images: facts.requestedImages } : {}),
    },
  };
}

function factsToAttributes(
  facts: ImageRequestFacts,
): Partial<Record<UnitBillingMatchKeyV1, string>> | undefined {
  const attributes: Partial<Record<UnitBillingMatchKeyV1, string>> = {};
  for (const key of ["model", "size", "quality", "resolution"] as const) {
    const value = facts[key];
    if (value !== undefined) attributes[key] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function parseUnitCount(value: string, unit: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Unit "${unit}" must be a canonical non-negative integer decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Unit "${unit}" exceeds the maximum safe integer`);
  }
  return Number(parsed);
}

function normalizedUnitCount(usage: UnitBillingUsage, unit: UnitBillingUnitV1): number {
  const value = usage.units[unit] ?? 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function componentMatchesContext(
  component: UnitBillingComponentV1,
  context: UnitBillingContext,
): boolean {
  const match = component.match;
  if (!match || Object.keys(match).length === 0) return true;
  const requestAttrs = context.attributes ?? {};
  for (const [key, expected] of Object.entries(match) as Array<[UnitBillingMatchKeyV1, string]>) {
    if (requestAttrs[key] !== expected) return false;
  }
  return true;
}

function capOutputImagesToRequest(
  outputImages: number | undefined,
  requestedImages: number | undefined,
): number | undefined {
  if (outputImages === undefined || requestedImages === undefined) {
    return outputImages;
  }
  return Math.min(outputImages, requestedImages);
}

function validateUsageWithinRequestLimits(
  usage: UnitBillingUsage,
  context: UnitBillingContext,
): void {
  const outputImageLimit = context.unitLimits?.output_images;
  const outputImages = usage.units.output_images;
  if (
    outputImageLimit !== undefined
    && outputImages !== undefined
    && outputImages > outputImageLimit
  ) {
    throw new Error(
      `Seller reported output_images=${outputImages} but request allowed ${outputImageLimit}`,
    );
  }
}

/**
 * Reject claims for more units than the buyer observed in the response it
 * actually received. A unit absent from the observed usage counts as zero, so
 * a positive claim against a response that delivered nothing is refused.
 */
function validateUsageWithinObservedUsage(
  usage: UnitBillingUsage,
  observed: UnitBillingUsage,
): void {
  for (const [unit, claimed] of Object.entries(usage.units)) {
    if (!isUnitBillingUnitV1(unit) || claimed === undefined || claimed <= 0) continue;
    const observedCount = observed.units[unit] ?? 0;
    if (claimed > observedCount) {
      throw new Error(
        `Seller reported ${unit}=${claimed} but response delivered ${observedCount}`,
      );
    }
  }
}
