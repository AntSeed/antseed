// ── Buyer-side cost estimation using tokenx ──────────────────────────

import { estimateTokenCount } from 'tokenx';

/** Token pricing for a service (USDC per million tokens). */
export interface ServicePricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Price per million cached input tokens. Defaults to inputUsdPerMillion (no discount) if not set. */
  cachedInputUsdPerMillion?: number;
}

const textDecoder = new TextDecoder();

/** Estimate token count from raw bytes using tokenx (~95-98% accuracy). */
export function estimateTokensFromBytes(bytes: Uint8Array): number {
  const text = textDecoder.decode(bytes);
  return estimateTokenCount(text);
}

/** Estimate token count from a string using tokenx. */
export function estimateTokensFromText(text: string): number {
  return estimateTokenCount(text);
}

/**
 * Compute USDC cost in base units (6 decimals) from token counts and pricing.
 * freshInputTokens and cachedInputTokens are independent counts (never overlapping),
 * so they are additive — no subtraction needed. This handles both OpenAI (where the
 * extraction layer splits prompt_tokens) and Anthropic (where input_tokens is fresh-only).
 */
export function computeCostUsdc(
  freshInputTokens: number,
  outputTokens: number,
  pricing: ServicePricing,
  cachedInputTokens = 0,
): bigint {
  const cachedPrice = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const freshCost = freshInputTokens * pricing.inputUsdPerMillion;
  const cachedCost = cachedInputTokens * cachedPrice;
  const outputCost = outputTokens * pricing.outputUsdPerMillion;
  const costUsd = (freshCost + cachedCost + outputCost) / 1_000_000;
  const costBaseUnits = Math.max(0, Math.round(costUsd * 1_000_000));
  return BigInt(costBaseUnits);
}

/**
 * Estimate USDC cost from raw content bytes using tokenx token estimation.
 */
export function estimateCostFromBytes(
  inputBytes: Uint8Array,
  outputBytes: Uint8Array,
  pricing: ServicePricing,
): { cost: bigint; inputTokens: number; outputTokens: number } {
  const inputTokens = estimateTokensFromBytes(inputBytes);
  const outputTokens = estimateTokensFromBytes(outputBytes);
  const cost = computeCostUsdc(inputTokens, outputTokens, pricing);
  return { cost, inputTokens, outputTokens };
}
