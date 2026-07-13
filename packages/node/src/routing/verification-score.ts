import type { ServiceVerificationStats } from '../payments/evm/verifier-client.js';
import type { PeerModelVerification } from '../types/peer.js';

const VERDICT_DIFF = 2;

/**
 * Minimum distinct verifiers before a clean history earns a positive score.
 *
 * Known limitation: the on-chain stats expose `distinctVerifierCount` (any
 * verdict) but not a per-verdict distinct-verifier count, so a verifier whose
 * only attestations are UNDETERMINED still counts toward this threshold. We
 * partially compensate by also requiring at least MIN_CORROBORATING_SAMES SAME
 * attestations, which rejects the smallest gameable case (one SAME plus an
 * UNDETERMINED-only second verifier), but two SAMEs from a single verifier
 * alongside an UNDETERMINED-only verifier can still pass. Fixing that fully
 * needs the contract to expose distinct-SAME-verifier counts.
 */
const MIN_CORROBORATING_VERIFIERS = 2;
const MIN_CORROBORATING_SAMES = 2;

/**
 * True when the clean-history evidence is corroborated enough to emit a
 * positive score. See MIN_CORROBORATING_VERIFIERS for why this is explicit
 * and what it cannot guarantee.
 */
function hasPositiveCorroboration(
  stats: Pick<ServiceVerificationStats, 'sameCount' | 'distinctVerifierCount'>,
): boolean {
  return (
    stats.sameCount >= MIN_CORROBORATING_SAMES
    && stats.distinctVerifierCount >= MIN_CORROBORATING_VERIFIERS
  );
}

/**
 * Compute a buyer-local model-authenticity score in [0,100] from on-chain
 * verification attestations for one (agent, service).
 *
 * Design goals:
 * - A STANDING substitution accusation dominates: `activeDiffVerifierCount`
 *   counts distinct verifiers whose LATEST verdict is DIFF. A verifier
 *   retracts its DIFF by later attesting SAME (mirroring the on-chain points
 *   penalty, which gates on the active count, not the monotonic history).
 * - Retracted DIFFs (historical `diffCount` with no active accuser) are a
 *   secondary signal only: they lower the clean-history ceiling but no longer
 *   dominate the score.
 * - Single-verifier histories are discounted: one verifier could be colluding
 *   or simply wrong, so corroborated evidence is required before a positive
 *   score is emitted (null otherwise) — see hasPositiveCorroboration.
 * - UNDETERMINED carries no signal (reference too weak / coverage too low).
 *
 * Returns null when there is no actionable evidence, so callers can distinguish
 * "unknown" from "known bad".
 */
export function computeModelVerificationScore(
  stats: Pick<
    ServiceVerificationStats,
    'sameCount' | 'diffCount' | 'distinctVerifierCount' | 'activeDiffVerifierCount'
  >,
): number | null {
  const { sameCount, diffCount, distinctVerifierCount, activeDiffVerifierCount } = stats;

  // Known bad: one or more verifiers currently stand by a DIFF verdict.
  // More SAMEs can partially offset a lone standing accusation, but the
  // ceiling stays low and drops further with each additional active accuser.
  if (activeDiffVerifierCount > 0) {
    const total = sameCount + diffCount;
    const cleanRatio = total > 0 ? sameCount / total : 0;
    const ceiling = 40 / activeDiffVerifierCount;
    return Math.round(cleanRatio * ceiling);
  }

  // No standing accusation but no corroboration either: not actionable yet.
  if (!hasPositiveCorroboration(stats)) return null;

  // Clean (or fully retracted) history. Confidence rises with corroborating
  // SAME attestations and distinct verifiers, saturating below 100
  // (fingerprinting is probabilistic; SAME is "not inconsistent", never proof).
  const sampleConfidence = 1 - 1 / (1 + sameCount); // 0.5 at 1, →1 asymptotically
  const verifierConfidence = Math.min(distinctVerifierCount / 4, 1); // full at 4 verifiers
  const score = 55 + 40 * sampleConfidence * verifierConfidence;
  // Historical (retracted) DIFFs cap the ceiling below a spotless history's.
  const ceiling = diffCount > 0 ? 75 : 95;
  return Math.round(Math.min(score, ceiling));
}

/** Build the PeerModelVerification view from raw on-chain stats. */
export function toPeerModelVerification(stats: ServiceVerificationStats): PeerModelVerification {
  return {
    sameCount: stats.sameCount,
    diffCount: stats.diffCount,
    undeterminedCount: stats.undeterminedCount,
    distinctVerifierCount: stats.distinctVerifierCount,
    activeDiffVerifierCount: stats.activeDiffVerifierCount,
    lastVerdict: stats.lastVerdict,
    score: computeModelVerificationScore(stats),
  };
}

/**
 * True when a peer has a STANDING substitution flag for the given model — at
 * least one verifier whose latest verdict is DIFF. Historical (retracted)
 * DIFFs do not flag; they only lower the score ceiling.
 *
 * `lastVerdict === DIFF` is kept as a fallback signal for stats decoded from
 * registry deployments that predate `activeDiffVerifierCount` (the decoder
 * defaults the missing field to 0).
 */
export function hasModelSubstitutionFlag(mv: PeerModelVerification | undefined): boolean {
  return mv !== undefined && (mv.activeDiffVerifierCount > 0 || mv.lastVerdict === VERDICT_DIFF);
}
