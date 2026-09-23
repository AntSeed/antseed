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
  nativeVideoFacts,
  nativeVideoAcceptance,
  type NativeVideoFacts,
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

export type BillingRequestFacts = ImageRequestFacts & { video?: NativeVideoFacts };

export interface CapturedUnitBillingContext {
  context: UnitBillingContext;
  requestUsage: UnitBillingUsage;
  requestFacts: BillingRequestFacts;
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
  const requestFacts: BillingRequestFacts = extractImageRequestFacts({
    path: args.request.path,
    method: args.request.method,
    body: parsed ?? undefined,
  });
  const video = nativeVideoFacts(args.request);
  if (video) requestFacts.video = video;
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
      ...(video ? { unitLimits: requestUsage.units, attributes: { model: args.service, ...(video.resolution ? { resolution: video.resolution } : {}) } } : {}),
    },
    requestUsage,
    requestFacts,
  };
}

export function extractUnitResponseUsage(
  response: SerializedHttpResponse,
  requestFacts?: BillingRequestFacts,
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  if (requestFacts?.video) {
    const video = requestFacts.video;
    const accepted = video.action === 'create'
      && !isIdempotentReplay(response)
      && nativeVideoAcceptance(video.protocol, response) !== null;
    return { usage: accepted ? factsToUnitUsage(requestFacts) : { units: {} }, tokenUsage: ZERO_TOKEN_USAGE };
  }
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

/** A seller replay of an already-accepted create; the original acceptance was the only charge. */
function isIdempotentReplay(response: SerializedHttpResponse): boolean {
  return Object.entries(response.headers).some(([key, value]) => key.toLowerCase() === 'x-antseed-idempotent-replay' && value === 'true');
}

export function computeFinalUnitBilling(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  response: SerializedHttpResponse,
  requestFacts?: BillingRequestFacts,
): FinalUnitBillingResult {
  const responseUsage = extractUnitResponseUsage(response, requestFacts);
  if (requestFacts?.video) responseUsage.usage = videoBillingUsage(model, requestFacts.video, responseUsage.usage);
  const costUsdc = evaluateUnitBilling(model, context, responseUsage.usage);
  return {
    usage: responseUsage.usage,
    tokenUsage: responseUsage.tokenUsage,
    costUsdc,
    billingUsage: unitUsageToBillingReport(responseUsage.usage),
  };
}

function factsToUnitUsage(facts: BillingRequestFacts): UnitBillingUsage {
  if (facts.video) {
    return { units: {
      video_generations: facts.video.count,
      video_seconds: (facts.video.duration ?? 0) * facts.video.count,
    } };
  }
  return {
    units: {
      ...(facts.requestedImages !== undefined ? { output_images: facts.requestedImages } : {}),
    },
  };
}

export function videoBillingUsage(model: UnitBillingModelV1, facts: NativeVideoFacts, usage: UnitBillingUsage): UnitBillingUsage {
  const units: UnitBillingUsage['units'] = {};
  if (facts.action !== 'create') return { units };
  for (const component of model.components) {
    if (component.unit === 'video_seconds' && facts.duration === undefined) throw new Error('Explicit video duration is required for per-second pricing');
    if (component.unit === 'video_generations' || component.unit === 'video_seconds') {
      units[component.unit] = usage.units[component.unit] ?? 0;
    }
  }
  return { units };
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
