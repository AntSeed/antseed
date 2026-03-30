// ── Buyer-side cost estimation using tokenx ──────────────────────────

import { estimateTokenCount } from 'tokenx';

/** Token pricing for a service (USDC per million tokens). */
export interface ServicePricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

const textDecoder = new TextDecoder();

/** Estimate token count from raw bytes using tokenx (~95-98% accuracy). */
export function estimateTokensFromBytes(bytes: Uint8Array | number): number {
  if (typeof bytes === 'number') {
    // Fallback for callers that only have byte length (no content).
    // Use bytes/4 as a rough approximation.
    return Math.ceil(bytes / 4);
  }
  const text = textDecoder.decode(bytes);
  return estimateTokenCount(text);
}

/** Estimate token count from a string using tokenx. */
export function estimateTokensFromText(text: string): number {
  return estimateTokenCount(text);
}

/**
 * Compute USDC cost in base units (6 decimals) from token counts and pricing.
 *
 * Formula: baseUnits = tokens * usdPerMillion / 1_000_000 * 1_000_000
 *        = tokens * usdPerMillion (but usdPerMillion is float, so round).
 */
export function computeCostUsdc(
  inputTokens: number,
  outputTokens: number,
  pricing: ServicePricing,
): bigint {
  const costUsd =
    (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
  const costBaseUnits = Math.max(0, Math.round(costUsd * 1_000_000));
  return BigInt(costBaseUnits);
}

/**
 * Estimate USDC cost from raw content bytes using tokenx token estimation.
 * Falls back to bytes/4 if only byte lengths (not content) are provided.
 */
export function estimateCostFromBytes(
  inputBytes: Uint8Array | number,
  outputBytes: Uint8Array | number,
  pricing: ServicePricing,
): { cost: bigint; inputTokens: number; outputTokens: number } {
  const inputTokens = estimateTokensFromBytes(inputBytes);
  const outputTokens = estimateTokensFromBytes(outputBytes);
  const cost = computeCostUsdc(inputTokens, outputTokens, pricing);
  return { cost, inputTokens, outputTokens };
}
