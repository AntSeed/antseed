import {
  extractProviderUsageFacts,
  extractRequestBillingFacts,
  parseJsonObject,
  type ProviderUsageFacts,
  type RequestBillingFacts,
  type TokenUsage,
} from "@antseed/api-adapter";
import type { SerializedHttpRequest, SerializedHttpResponse } from "../types/http.js";
import type { BillingMeterV1, NormalizedUsage } from "../types/billing.js";
import { estimateTokensFromBytes } from "../payments/pricing.js";

export type { ProviderUsageFacts, RequestBillingFacts, TokenUsage };

/**
 * Build request-known usage for seller preflight and buyer context capture.
 *
 * This is intentionally not final billing: output_images here is the requested
 * count/default used to estimate reserve before the provider call. Final
 * billing uses normalizeResponseUsage so partial responses bill only delivered
 * images.
 */
export function normalizeRequestUsage(request: SerializedHttpRequest): {
  usage: NormalizedUsage;
  requestFacts: RequestBillingFacts;
} {
  const parsed = parseJsonObject(request.body);
  const facts = extractRequestBillingFacts({
    path: request.path,
    method: request.method,
    body: parsed ?? undefined,
  });
  const meters: Partial<Record<BillingMeterV1, number>> = {
    text_input_tokens: estimateTokensFromBytes(request.body),
  };
  if (facts.requestedOutputImages !== undefined) meters.output_images = facts.requestedOutputImages;
  return {
    usage: {
      meters,
      ...(facts.attributes ? { attributes: facts.attributes } : {}),
      ...(facts.meterAttributes ? { meterAttributes: facts.meterAttributes } : {}),
    },
    requestFacts: facts,
  };
}

/**
 * Convert a provider response into canonical billable usage.
 *
 * JSON responses are parsed directly; streaming responses are scanned for the
 * richest usage event. Request facts are reattached only as match context
 * (model/size/quality/resolution), while delivered meters such as output_images
 * come from the response itself.
 */
export function normalizeResponseUsage(
  response: SerializedHttpResponse,
  requestFacts?: RequestBillingFacts,
): {
  usage: NormalizedUsage;
  tokenUsage: TokenUsage;
  responseFacts: ProviderUsageFacts;
} {
  const parsed = parseJsonObject(response.body);
  const responseFacts = parsed
    ? extractProviderUsageFacts(parsed)
    : extractStreamingProviderUsageFacts(response.body);
  return factsToNormalizedUsage(responseFacts, requestFacts);
}

/**
 * Shared mapper from adapter facts to billing usage.
 *
 * The fallback to TokenUsage preserves legacy token behavior. More specific
 * text token fields win when providers expose token classes, and output_images
 * is populated only when a response has a data array.
 */
export function factsToNormalizedUsage(
  responseFacts: ProviderUsageFacts,
  requestFacts?: RequestBillingFacts,
): {
  usage: NormalizedUsage;
  tokenUsage: TokenUsage;
  responseFacts: ProviderUsageFacts;
} {
  const tokenUsage = responseFacts.tokenUsage;
  const meters: Partial<Record<BillingMeterV1, number>> = {
    text_input_tokens: responseFacts.textInputTokens ?? tokenUsage.freshInputTokens,
    cached_text_input_tokens: responseFacts.cachedTextInputTokens ?? tokenUsage.cachedInputTokens,
    output_text_tokens: responseFacts.outputTextTokens ?? tokenUsage.outputTokens,
  };
  if (responseFacts.outputImages !== undefined) {
    meters.output_images = responseFacts.outputImages;
  }
  return {
    usage: {
      meters,
      ...(requestFacts?.attributes ? { attributes: requestFacts.attributes } : {}),
      ...(requestFacts?.meterAttributes ? { meterAttributes: requestFacts.meterAttributes } : {}),
    },
    tokenUsage,
    responseFacts,
  };
}

function extractStreamingProviderUsageFacts(body: Uint8Array): ProviderUsageFacts {
  const text = new TextDecoder().decode(body);
  let best: ProviderUsageFacts | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const facts = extractProviderUsageFacts(parsed as Record<string, unknown>);
      if (!best || facts.tokenUsage.inputTokens > best.tokenUsage.inputTokens || facts.tokenUsage.outputTokens > best.tokenUsage.outputTokens) {
        best = facts;
      }
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }
  return best ?? extractProviderUsageFacts({});
}
