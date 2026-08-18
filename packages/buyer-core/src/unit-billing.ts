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
  const attributes = factsToAttributes(requestFacts, args.request.path);
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

function factsToUnitUsage(facts: ImageRequestFacts): UnitBillingUsage {
  return {
    units: {
      ...(facts.requestedImages !== undefined ? { output_images: facts.requestedImages } : {}),
    },
  };
}

function factsToAttributes(
  facts: ImageRequestFacts,
  requestPath: string,
): Partial<Record<UnitBillingMatchKeyV1, string>> | undefined {
  const attributes: Partial<Record<UnitBillingMatchKeyV1, string>> = {};
  for (const key of ['model', 'size', 'quality', 'resolution'] as const) {
    const value = facts[key];
    if (value !== undefined) attributes[key] = value;
  }
  const operation = imageOperationFromPath(requestPath);
  if (operation) attributes.operation = operation;
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function imageOperationFromPath(path: string): string | undefined {
  switch (path.split('?', 1)[0]?.toLowerCase()) {
    case '/v1/images/generations':
      return 'image_generation';
    case '/v1/images/edits':
      return 'image_edit';
    default:
      return undefined;
  }
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
