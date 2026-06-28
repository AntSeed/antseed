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
  type RequestBillingFacts,
  type TokenUsage,
  extractProviderUsageFacts,
  extractRequestBillingFacts,
  parseJsonObject,
} from "@antseed/api-adapter";
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
  const parsed = parseJsonObject(args.request.body);
  const requestFacts = extractRequestBillingFacts({
    path: args.request.path,
    method: args.request.method,
    body: parsed ?? undefined,
  });
  const requestUsage = factsToImageUsage({
    outputImages: requestFacts.requestedOutputImages,
    requestFacts,
  });
  return {
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      ...(requestFacts.attributes
        ? { attributes: requestFacts.attributes }
        : {}),
      ...(requestFacts.meterAttributes
        ? { meterAttributes: requestFacts.meterAttributes }
        : {}),
    },
    requestUsage,
    requestFacts,
  };
}

export const captureSellerBillingContext = captureBillingContext;

export function computeFinalCost(
  model: ServiceBillingModelV1,
  context: BuyerRequestBillingContext,
  response: SerializedHttpResponse,
  requestFacts?: RequestBillingFacts,
): FinalBillingResult {
  const parsed = parseJsonObject(response.body);
  const responseFacts = parsed
    ? extractProviderUsageFacts(parsed)
    : extractStreamingProviderUsageFacts(response.body);
  const usage = usageWithTrustedContext(
    factsToImageUsage({ outputImages: responseFacts.outputImages, requestFacts }),
    context,
  );
  const evaluation = evaluateBillingModel(model, usage);
  return {
    usage,
    tokenUsage: responseFacts.tokenUsage,
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

function factsToImageUsage(args: {
  outputImages?: number;
  requestFacts?: RequestBillingFacts;
}): NormalizedUsage {
  return {
    meters: {
      ...(args.outputImages !== undefined ? { output_images: args.outputImages } : {}),
    },
    ...(args.requestFacts?.attributes ? { attributes: args.requestFacts.attributes } : {}),
    ...(args.requestFacts?.meterAttributes ? { meterAttributes: args.requestFacts.meterAttributes } : {}),
  };
}

function extractStreamingProviderUsageFacts(body: Uint8Array): ReturnType<typeof extractProviderUsageFacts> {
  const text = new TextDecoder().decode(body);
  let best: ReturnType<typeof extractProviderUsageFacts> | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const facts = extractProviderUsageFacts(parsed as Record<string, unknown>);
      if (
        !best
        || (facts.outputImages ?? 0) > (best.outputImages ?? 0)
        || facts.tokenUsage.inputTokens > best.tokenUsage.inputTokens
        || facts.tokenUsage.outputTokens > best.tokenUsage.outputTokens
      ) {
        best = facts;
      }
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }
  return best ?? extractProviderUsageFacts({});
}
