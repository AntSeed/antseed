import { scoreFromTrust } from './on-chain-reputation.js';

export const MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER = 0.5;

export type ModelReputationSource = {
  onChainReputationScore?: number | null;
  onChainTrustScore?: number | null;
  reputationScore?: number | null;
};

function finiteScore(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Normalize every reputation source to the protocol's 0-100 score. */
export function normalizedModelReputationScore(source: ModelReputationSource): number | null {
  const reputation = finiteScore(source.onChainReputationScore);
  if (reputation !== null) return reputation;

  const trust = finiteScore(source.onChainTrustScore);
  if (trust !== null) return scoreFromTrust(trust);

  return finiteScore(source.reputationScore);
}

/** Apply model-specific pricing completeness to a normalized reputation. */
export function effectiveModelReputationScore(
  reputation: number | null,
  hasCachedInputPricing: boolean,
  modelHasCachedInputPricing: boolean,
): number | null {
  if (reputation === null) return null;
  return modelHasCachedInputPricing && !hasCachedInputPricing
    ? reputation * MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER
    : reputation;
}

export function compareEffectiveModelReputation(
  a: { effectiveReputationScore?: number | null; peerId: string },
  b: { effectiveReputationScore?: number | null; peerId: string },
): number {
  return (b.effectiveReputationScore ?? -1) - (a.effectiveReputationScore ?? -1)
    || a.peerId.localeCompare(b.peerId);
}
