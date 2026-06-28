import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
} from "../types/http.js";
import type {
  BillingUsageReportV1,
  BuyerRequestBillingContext,
  NormalizedUsage,
  ServiceBillingModelV1,
} from "../types/billing.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import {
  evaluateBillingModel,
  usageFromBillingReport,
  validateBillingUsageReportV1,
} from "./evaluator.js";
import {
  normalizeRequestUsage,
  normalizeResponseUsage,
  type RequestBillingFacts,
  type TokenUsage,
} from "./usage-normalization.js";
import { normalizedUsageToBillingReport } from "../types/billing.js";

export interface CapturedBillingContext {
  /** Trusted identity + match attributes used later to validate unit billing. */
  context: BuyerRequestBillingContext;
  /** Request-known meter estimate for seller preflight, not final delivered usage. */
  requestUsage: NormalizedUsage;
  /** Adapter-level request facts reused when final response usage is normalized. */
  requestFacts: RequestBillingFacts;
}

export interface FinalBillingResult {
  usage: NormalizedUsage;
  tokenUsage: TokenUsage;
  costUsdc: bigint;
  billingUsage: BillingUsageReportV1;
}

export function captureBillingContext(args: {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  request: SerializedHttpRequest;
}): CapturedBillingContext {
  const normalized = normalizeRequestUsage(args.request);
  return {
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      ...(normalized.requestFacts.attributes
        ? { attributes: normalized.requestFacts.attributes }
        : {}),
      ...(normalized.requestFacts.meterAttributes
        ? { meterAttributes: normalized.requestFacts.meterAttributes }
        : {}),
    },
    requestUsage: normalized.usage,
    requestFacts: normalized.requestFacts,
  };
}

export const captureSellerBillingContext = captureBillingContext;

export function computeFinalCost(
  model: ServiceBillingModelV1,
  context: BuyerRequestBillingContext,
  response: SerializedHttpResponse,
  requestFacts?: RequestBillingFacts,
): FinalBillingResult {
  const normalized = normalizeResponseUsage(response, requestFacts);
  const usage = usageWithTrustedContext(normalized.usage, context);
  const evaluation = evaluateBillingModel(model, usage);
  return {
    usage,
    tokenUsage: normalized.tokenUsage,
    costUsdc: evaluation.costUsdc,
    billingUsage: normalizedUsageToBillingReport(usage, evaluation.costUsdc),
  };
}

export function validateBillingUsageReport(
  model: ServiceBillingModelV1,
  context: BuyerRequestBillingContext,
  report: BillingUsageReportV1,
  costToleranceMultiplier: number,
): bigint {
  const errors = validateBillingUsageReportV1(report);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  const sellerCost = BigInt(report.costUsdc);
  const usage = usageFromBillingReport(report, context);
  const buyerEstimate = evaluateBillingModel(model, usage).costUsdc;
  if (sellerCost > 0n && buyerEstimate <= 0n) {
    throw new Error("Positive billingUsage cost recomputed to zero");
  }

  const maxAcceptable = BigInt(
    Math.ceil(Number(buyerEstimate) * costToleranceMultiplier),
  );
  if (sellerCost > maxAcceptable) {
    throw new Error(
      `Seller billingUsage cost ${sellerCost} exceeds buyer estimate ${buyerEstimate}`,
    );
  }
  return sellerCost;
}

function usageWithTrustedContext(
  usage: NormalizedUsage,
  context: Pick<BuyerRequestBillingContext, "attributes" | "meterAttributes">,
): NormalizedUsage {
  return {
    meters: usage.meters,
    ...(context.attributes ? { attributes: context.attributes } : {}),
    ...(context.meterAttributes
      ? { meterAttributes: context.meterAttributes }
      : {}),
  };
}
