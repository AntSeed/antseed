import { extractProviderResponseFacts, getQuantityBillingAdapter, validateQuantityBillingConditions, parseJsonObject, type TokenUsage } from '@antseed/api-adapter';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import { evaluateUnitBilling, resolveUnitPriceMicroUsdc, validateUnitBillingModelV2, unitUsageToBillingReport, type UnitBillingContext, type UnitBillingModelV2, type UnitBillingUsage, type UnitBillingUsageReportV2 } from '@antseed/protocol/billing';
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
  unitModel?: UnitBillingModelV2;
}): CapturedUnitBillingContext {
  const adapter = getQuantityBillingAdapter(args.serviceApiProtocol);
  const facts = adapter && (args.unitModel || args.serviceApiProtocol === 'openai-images')
    ? adapter.captureRequest(args.request) : { attributes: {}, maxQuantity: 1 };
  const context: UnitBillingContext = { sellerPeerId: args.sellerPeerId, provider: args.provider,
    service: args.service, serviceApiProtocol: args.serviceApiProtocol, maxQuantity: facts.maxQuantity, attributes: facts.attributes };
  if (args.unitModel) {
    assertQuantityBillingModel(args.unitModel, context.serviceApiProtocol);
    resolveUnitPriceMicroUsdc(args.unitModel, context);
  }
  return {
    context,
    requestUsage: { quantity: facts.maxQuantity },
    ...(facts.estimatedPromptTokens !== undefined ? { estimatedPromptTokens: facts.estimatedPromptTokens } : {}),
  };
}

export function extractUnitResponseUsage(response: SerializedHttpResponse, context: UnitBillingContext): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  const adapter = getQuantityBillingAdapter(context.serviceApiProtocol);
  if (!adapter) throw new Error('Unsupported quantity billing response adapter');
  const parsed = parseJsonObject(response.body);
  const facts = parsed ? extractProviderResponseFacts(parsed) : { tokenUsage: ZERO_TOKEN_USAGE };
  const quantity = adapter.measureResponse(response);
  if (quantity > (context.maxQuantity ?? (context.serviceApiProtocol === 'openai-images' ? Number.MAX_SAFE_INTEGER : 1))) throw new Error('Response quantity exceeds request limit');
  return { usage: { quantity }, tokenUsage: facts.tokenUsage };
}

export function computeFinalUnitBilling(model: UnitBillingModelV2, context: UnitBillingContext, response: SerializedHttpResponse): FinalUnitBillingResult {
  assertQuantityBillingModel(model, context.serviceApiProtocol);
  const result = extractUnitResponseUsage(response, context);
  return { ...result, costUsdc: evaluateUnitBilling(model, context, result.usage), billingUsage: unitUsageToBillingReport(result.usage) };
}

export function assertQuantityBillingModel(model: UnitBillingModelV2, protocol: string): void {
  const errors = validateUnitBillingModelV2(model);
  if (errors.length === 0) errors.push(...validateQuantityBillingConditions(protocol, model));
  if (errors.length) throw new Error(errors.join('; '));
}

export { validateQuantityBillingConditions } from '@antseed/api-adapter';
