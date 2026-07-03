import type { ServiceVerificationStats } from '../payments/evm/verifier-client.js';
import type { PeerModelVerification } from '../types/peer.js';

const VERDICT_DIFF = 2;

/**
 * Compute a buyer-local model-authenticity score in [0,100] from on-chain
 * verification attestations for one (agent, service).
 *
 * Design goals:
 * - A confirmed substitution (any DIFF) is a strong negative signal — a single
 *   DIFF should dominate several SAMEs, because a seller who ever served the
 *   wrong model is not trustworthy for that model.
 * - Single-verifier histories are discounted: one verifier could be colluding
 *   or simply wrong, so evidence from ≥2 distinct verifiers is required before
 *   a positive score is emitted (null otherwise).
 * - UNDETERMINED carries no signal (reference too weak / coverage too low).
 *
 * Returns null when there is no actionable evidence, so callers can distinguish
 * "unknown" from "known bad".
 */
export function computeModelVerificationScore(
  stats: Pick<ServiceVerificationStats, 'sameCount' | 'diffCount' | 'distinctVerifierCount'>,
): number | null {
  const { sameCount, diffCount, distinctVerifierCount } = stats;

  // Known bad: any confirmed substitution flags the model regardless of
  // verifier count — a DIFF is backed by seller-signed evidence on-chain.
  if (diffCount > 0) {
    // More SAMEs from independent verifiers can partially offset a stale DIFF,
    // but the ceiling stays low. Ratio of clean:dirty, scaled into [0,40].
    const total = sameCount + diffCount;
    const cleanRatio = total > 0 ? sameCount / total : 0;
    return Math.round(cleanRatio * 40);
  }

  // No DIFF but no corroboration: not actionable yet.
  if (sameCount === 0 || distinctVerifierCount < 2) return null;

  // Clean history. Confidence rises with corroborating SAME attestations and
  // distinct verifiers, saturating below 100 (fingerprinting is probabilistic;
  // SAME is "not inconsistent", never proof).
  const sampleConfidence = 1 - 1 / (1 + sameCount); // 0.5 at 1, →1 asymptotically
  const verifierConfidence = Math.min(distinctVerifierCount / 4, 1); // full at 4 verifiers
  const score = 55 + 40 * sampleConfidence * verifierConfidence;
  return Math.round(Math.min(score, 95));
}

/** Build the PeerModelVerification view from raw on-chain stats. */
export function toPeerModelVerification(stats: ServiceVerificationStats): PeerModelVerification {
  return {
    sameCount: stats.sameCount,
    diffCount: stats.diffCount,
    undeterminedCount: stats.undeterminedCount,
    distinctVerifierCount: stats.distinctVerifierCount,
    lastVerdict: stats.lastVerdict,
    score: computeModelVerificationScore(stats),
  };
}

/** True when a peer has a confirmed substitution flag for the given model. */
export function hasModelSubstitutionFlag(mv: PeerModelVerification | undefined): boolean {
  return mv !== undefined && (mv.diffCount > 0 || mv.lastVerdict === VERDICT_DIFF);
}
