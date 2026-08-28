/**
 * Measured savings: what the buyer actually paid vs what the same tokens
 * would have cost at OpenRouter retail prices.
 *
 * Inputs are the per-service usage totals from the buyer daemon (actual USDC
 * signed per model, token counts split fresh/cached) and the OpenRouter
 * reference-price map already cached for the Popular-list strikethrough.
 * Models with no retail match are excluded from BOTH sides so the ratio
 * compares like with like. Returns null until at least one matched service
 * has a positive baseline cost.
 */
import type { DesktopBuyerServiceUsage } from '../../types/bridge';
import type { OpenRouterReferenceMap } from './openrouter-baseline.js';
import { canonicalModelKey } from './model-identity.js';

const USDC_BASE_UNITS_PER_USD = 1_000_000;

export type MeasuredSavings = {
  /** Rounded 0–100 percent saved vs retail. */
  pct: number;
  /** USD actually paid across matched services. */
  actualUsd: number;
  /** USD the same tokens would cost at retail. */
  baselineUsd: number;
  /** Services that counted (matched a retail price). */
  matchedServices: number;
};

function toNumberTokens(value: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

/**
 * Compact USD label for the Saving tile: "$0.42", "$12.40", "$1.2k".
 * Sub-cent amounts render as "<$0.01" so tiny savings don't show as "$0.00".
 */
export function formatSavedUsd(usd: number): string {
  const value = Number.isFinite(usd) && usd > 0 ? usd : 0;
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/**
 * Compute measured savings from per-service usage. Free usage counts: those
 * tokens cost $0 and legitimately widen the gap vs retail.
 */
export function computeMeasuredSavings(
  services: DesktopBuyerServiceUsage[] | undefined,
  referenceMap: OpenRouterReferenceMap | null,
): MeasuredSavings | null {
  if (!services || services.length === 0 || !referenceMap) return null;

  let actualUsd = 0;
  let baselineUsd = 0;
  let matchedServices = 0;

  for (const service of services) {
    if (!service.serviceName) continue;
    const ref = referenceMap[canonicalModelKey(service.serviceName)];
    if (!ref || (ref.input === null && ref.output === null)) continue;

    // Buyer-side inputTokens are total logical input (fresh + cached) —
    // see buyer-payment-manager. Split fresh for pricing.
    const totalInput = toNumberTokens(service.inputTokens);
    const cached = Math.min(toNumberTokens(service.cachedInputTokens), totalInput);
    const freshInput = totalInput - cached;
    const output = toNumberTokens(service.outputTokens);
    if (totalInput === 0 && output === 0) continue;

    const inputPrice = ref.input ?? 0;
    const cachedPrice = ref.cachedInput ?? inputPrice;
    const outputPrice = ref.output ?? 0;
    const serviceBaseline =
      (freshInput * inputPrice + cached * cachedPrice + output * outputPrice) / 1_000_000;
    if (serviceBaseline <= 0) continue;

    baselineUsd += serviceBaseline;
    actualUsd += toNumberTokens(service.amountUsdc) / USDC_BASE_UNITS_PER_USD;
    matchedServices += 1;
  }

  if (matchedServices === 0 || baselineUsd <= 0) return null;
  // Paying above retail is not "saving" — clamp instead of showing negatives.
  const pct = Math.round(Math.max(0, Math.min(1, 1 - actualUsd / baselineUsd)) * 100);
  return { pct, actualUsd, baselineUsd, matchedServices };
}

export type OfficialBaseline = {
  baselineUsd: number;
  matchedServices: number;
  matchedInputTokens: number;
  matchedOutputTokens: number;
};

/** Official-price value only, for surfaces that describe free usage rather
 * than the difference between retail and the amount actually paid. */
export function computeOfficialBaselineUsd(
  services: DesktopBuyerServiceUsage[] | undefined,
  referenceMap: OpenRouterReferenceMap | null,
): OfficialBaseline | null {
  if (!services || services.length === 0 || !referenceMap) return null;

  let baselineUsd = 0;
  let matchedServices = 0;
  let matchedInputTokens = 0;
  let matchedOutputTokens = 0;

  for (const service of services) {
    if (!service.serviceName) continue;
    const ref = referenceMap[canonicalModelKey(service.serviceName)];
    if (!ref || (ref.input === null && ref.output === null)) continue;

    const totalInput = toNumberTokens(service.inputTokens);
    const cached = Math.min(toNumberTokens(service.cachedInputTokens), totalInput);
    const freshInput = totalInput - cached;
    const output = toNumberTokens(service.outputTokens);
    if (totalInput === 0 && output === 0) continue;

    const inputPrice = ref.input ?? 0;
    const cachedPrice = ref.cachedInput ?? inputPrice;
    const outputPrice = ref.output ?? 0;
    const inputBaseline = ref.input === null
      ? 0
      : (freshInput * inputPrice + cached * cachedPrice) / 1_000_000;
    const outputBaseline = ref.output === null ? 0 : output * outputPrice / 1_000_000;
    const serviceBaseline = inputBaseline + outputBaseline;
    if (serviceBaseline <= 0) continue;

    baselineUsd += serviceBaseline;
    matchedServices += 1;
    if (ref.input !== null) matchedInputTokens += totalInput;
    if (ref.output !== null) matchedOutputTokens += output;
  }

  if (matchedServices === 0 || baselineUsd <= 0) return null;
  return { baselineUsd, matchedServices, matchedInputTokens, matchedOutputTokens };
}
