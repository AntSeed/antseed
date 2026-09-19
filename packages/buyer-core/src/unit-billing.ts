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
  UnitBillingUnitV1,
  UnitBillingUsage,
  UnitBillingUsageReportV1,
} from '@antseed/protocol/billing';
import {
  evaluateUnitBilling,
  GENERATED_IMAGE_OUTPUT_UNIT_V1,
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
  estimatedPromptTokens?: number;
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
  const imageFacts = extractImageRequestFacts({
    path: args.request.path,
    method: args.request.method,
    body: parsed ?? undefined,
  });
  const unitLimits: NonNullable<UnitBillingContext['unitLimits']> = {
    successful_requests: 1,
    ...(imageFacts.requestedImages !== undefined ? { output_images: imageFacts.requestedImages } : {}),
  };
  const attributes = factsToAttributes(imageFacts);
  return {
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      ...(attributes ? { attributes } : {}),
      unitLimits,
    },
    requestUsage: { units: { ...unitLimits } },
    ...(imageFacts.promptTokens !== undefined ? { estimatedPromptTokens: imageFacts.promptTokens } : {}),
  };
}

export function extractUnitResponseUsage(
  response: SerializedHttpResponse,
  unitLimits?: UnitBillingContext['unitLimits'],
  billableUnits: readonly UnitBillingUnitV1[] = [GENERATED_IMAGE_OUTPUT_UNIT_V1],
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  const parsed = parseJsonObject(response.body);
  const responseFacts: ProviderResponseFacts = parsed
    ? extractProviderResponseFacts(parsed)
    : { tokenUsage: ZERO_TOKEN_USAGE };
  const outputImages = capOutputImagesToRequest(
    responseFacts.outputImages,
    unitLimits?.output_images,
  );
  const measuredUnits: UnitBillingUsage['units'] = {
    successful_requests: response.statusCode >= 200 && response.statusCode < 300 ? 1 : 0,
    ...(outputImages !== undefined ? { output_images: outputImages } : {}),
  };
  const units: UnitBillingUsage['units'] = {};
  for (const unit of billableUnits) {
    const count = measuredUnits[unit];
    if (count !== undefined) units[unit] = count;
  }
  return {
    usage: { units },
    tokenUsage: responseFacts.tokenUsage,
  };
}

export function computeFinalUnitBilling(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  response: SerializedHttpResponse,
): FinalUnitBillingResult {
  const perCall = model.components.some((component) => component.unit === PER_CALL_BILLING_UNIT_V1);
  const responseUsage = extractUnitResponseUsage(response, context.unitLimits,
    [perCall ? PER_CALL_BILLING_UNIT_V1 : GENERATED_IMAGE_OUTPUT_UNIT_V1]);
  const costUsdc = evaluateUnitBilling(model, context, responseUsage.usage);
  return {
    usage: responseUsage.usage,
    tokenUsage: responseUsage.tokenUsage,
    costUsdc,
    billingUsage: unitUsageToBillingReport(responseUsage.usage),
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
