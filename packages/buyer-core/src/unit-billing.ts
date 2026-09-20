import { extractImageRequestFacts, extractProviderResponseFacts, extractRequestBodyFields, parseJsonObject, type TokenUsage } from '@antseed/api-adapter';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import { evaluateUnitBilling, isQuantityBillingProtocol, unitUsageToBillingReport, type UnitBillingContext, type UnitBillingModelV2, type UnitBillingUsage, type UnitBillingUsageReportV2 } from '@antseed/protocol/billing';
import type { ServiceApiProtocol } from '@antseed/protocol/service-api';

const ZERO_TOKEN_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };

export interface CapturedUnitBillingContext {
  context: UnitBillingContext;
  requestUsage: UnitBillingUsage;
  estimatedPromptTokens?: number;
}

export interface FinalUnitBillingResult {
  usage: UnitBillingUsage;
  tokenUsage: TokenUsage;
  costUsdc: bigint;
  billingUsage: UnitBillingUsageReportV2;
}

export function captureUnitBillingContext(args: {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  request: SerializedHttpRequest;
}): CapturedUnitBillingContext {
  const parsed = extractRequestBodyFields(args.request.headers, args.request.body);
  const facts = extractImageRequestFacts({ path: args.request.path, method: args.request.method, body: parsed ?? undefined });
  const isImage = args.serviceApiProtocol === 'openai-images';
  if (isImage && parsed?.n !== undefined
    && ((typeof parsed.n !== 'number' && typeof parsed.n !== 'string')
      || !/^[1-9]\d*$/.test(String(parsed.n)) || !Number.isSafeInteger(Number(parsed.n)))) {
    throw new Error('Image quantity must be a positive safe integer');
  }
  const maxQuantity = isImage ? facts.requestedImages ?? 1 : 1;
  return {
    context: { sellerPeerId: args.sellerPeerId, provider: args.provider, service: args.service, serviceApiProtocol: args.serviceApiProtocol, maxQuantity },
    requestUsage: { quantity: maxQuantity },
    ...(facts.promptTokens !== undefined ? { estimatedPromptTokens: facts.promptTokens } : {}),
  };
}

export function extractUnitResponseUsage(response: SerializedHttpResponse, context: UnitBillingContext): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  if (!isQuantityBillingProtocol(context.serviceApiProtocol)) throw new Error('Unsupported quantity billing response adapter');
  const parsed = parseJsonObject(response.body);
  const facts = parsed ? extractProviderResponseFacts(parsed) : { tokenUsage: ZERO_TOKEN_USAGE };
  let quantity = 0;
  if (response.statusCode >= 200 && response.statusCode < 300 && parsed && !parsed.error) {
    if (context.serviceApiProtocol === 'openai-images') {
      quantity = facts.outputImages ?? 0;
    } else if (context.serviceApiProtocol === 'antseed-routing') {
      quantity = parsed.version === 1 && Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0 ? 1 : 0;
    } else {
      quantity = Array.isArray(parsed.choices) && parsed.choices.some(choice => choice && typeof choice === 'object' && choice.message && typeof choice.message === 'object') ? 1 : 0;
    }
  }
  if (quantity > (context.maxQuantity ?? (context.serviceApiProtocol === 'openai-images' ? Number.MAX_SAFE_INTEGER : 1))) throw new Error('Response quantity exceeds request limit');
  return { usage: { quantity }, tokenUsage: facts.tokenUsage };
}

export function computeFinalUnitBilling(model: UnitBillingModelV2, context: UnitBillingContext, response: SerializedHttpResponse): FinalUnitBillingResult {
  const result = extractUnitResponseUsage(response, context);
  return { ...result, costUsdc: evaluateUnitBilling(model, context, result.usage), billingUsage: unitUsageToBillingReport(result.usage) };
}
