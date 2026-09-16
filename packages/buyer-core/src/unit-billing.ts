import type {
  ImageRequestFacts,
  ProviderResponseFacts,
  TokenUsage,
} from '@antseed/api-adapter';
import {
  extractImageRequestFacts,
  extractProviderResponseFacts,
  extractRequestBodyFields,
  parseJsonObject,
} from '@antseed/api-adapter';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import type {
  UnitBillingContext,
  UnitBillingMatchKeyV1,
  UnitBillingModelV1,
  UnitBillingUsage,
  UnitBillingUsageReportV1,
} from '@antseed/protocol/billing';
import {
  evaluateUnitBilling,
  PER_CALL_BILLING_UNIT_V1,
  unitUsageToBillingReport,
} from '@antseed/protocol/billing';
import type { ServiceApiProtocol } from '@antseed/protocol/service-api';

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  freshInputTokens: 0,
  cachedInputTokens: 0,
};

export interface CapturedUnitBillingContext {
  context: UnitBillingContext;
  requestUsage: UnitBillingUsage;
  requestFacts: ImageRequestFacts;
}

export interface FinalUnitBillingResult {
  usage: UnitBillingUsage;
  tokenUsage: TokenUsage;
  costUsdc: bigint;
  billingUsage: UnitBillingUsageReportV1;
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
      unitLimits: { successful_requests: 1, ...(requestFacts.requestedImages !== undefined
        ? { output_images: requestFacts.requestedImages } : {}) },
    },
    requestUsage,
    requestFacts,
  };
}

export function extractUnitResponseUsage(
  response: SerializedHttpResponse,
  requestFacts?: ImageRequestFacts,
  includeSuccessfulRequests = false,
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
        ...(includeSuccessfulRequests ? { successful_requests: response.statusCode >= 200 && response.statusCode < 300 ? 1 : 0 } : {}),
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
  const perCall = model.components.some((component) => component.unit === PER_CALL_BILLING_UNIT_V1);
  const responseUsage = extractUnitResponseUsage(response, requestFacts, perCall);
  if (perCall) delete responseUsage.usage.units.output_images;
  const costUsdc = evaluateUnitBilling(model, context, responseUsage.usage);
  return {
    usage: responseUsage.usage,
    tokenUsage: responseUsage.tokenUsage,
    costUsdc,
    billingUsage: unitUsageToBillingReport(responseUsage.usage),
  };
}

function factsToUnitUsage(facts: ImageRequestFacts): UnitBillingUsage {
  return {
    units: {
      successful_requests: 1,
      ...(facts.requestedImages !== undefined ? { output_images: facts.requestedImages } : {}),
    },
  };
}

function factsToAttributes(
  facts: ImageRequestFacts,
): Partial<Record<UnitBillingMatchKeyV1, string>> | undefined {
  const attributes: Partial<Record<UnitBillingMatchKeyV1, string>> = {};
  for (const key of ['model', 'size', 'quality', 'resolution'] as const) {
    const value = facts[key];
    if (value !== undefined) attributes[key] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
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
