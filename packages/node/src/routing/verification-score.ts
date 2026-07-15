import {
  DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS,
  type ServiceVerificationStats,
} from '../payments/evm/verifier-client.js';
import type { PeerModelVerification } from '../types/peer.js';

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
 * Distinct standing-DIFF verifiers required before routing EXCLUDES a seller
 * — the OFFLINE FALLBACK for `AntseedVerifierPointsPolicy
 * .minDistinctDiffVerifiers` (contract default 2): the on-chain economic
 * penalty (zeroed emissions) only triggers once this many distinct verifiers
 * stand by a DIFF verdict, so routing must use the same corroboration bar.
 * Excluding on a single accuser would make one malicious or simply-wrong
 * verifier a full routing kill-switch on an honest seller — a
 * griefing/extortion primitive — while the economics still paid the seller in
 * full. A single standing DIFF still DEPRIORITIZES (it lowers the authenticity
 * score in computeModelVerificationScore), but does not exclude.
 *
 * The owner can retune the on-chain value (`setMinDistinctDiffVerifiers`), so
 * this constant is NOT read at decision time when live data is available:
 * `VerifierRegistryClient.getMinDistinctDiffVerifiers()` reads the policy's
 * current value (TTL-cached, this constant on any failure) and enrichment
 * (`_enrichPeersWithVerification` in node.ts) stamps it onto each
 * `PeerModelVerification` as `exclusionThreshold`, where
 * `hasModelSubstitutionFlag` picks it up. This constant only decides when the
 * chain is unreachable, no verifier registry is configured, or a stamp is
 * missing (e.g. pre-upgrade persisted state).
 */
export const MIN_DISTINCT_DIFF_VERIFIERS_FOR_EXCLUSION = DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS;

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

/**
 * Build the PeerModelVerification view from raw on-chain stats.
 *
 * `exclusionThreshold` is the effective points-policy
 * `minDistinctDiffVerifiers` read from chain at enrichment time
 * (`VerifierRegistryClient.getMinDistinctDiffVerifiers()`). Stamping it here
 * makes the threshold travel WITH the evidence — through routing, the CLI
 * buyer-proxy, and even its persisted warm cache — so every consumer of
 * `hasModelSubstitutionFlag` excludes at the same bar as the on-chain
 * economic penalty without re-reading the chain per decision.
 */
export function toPeerModelVerification(
  stats: ServiceVerificationStats,
  exclusionThreshold?: number,
): PeerModelVerification {
  return {
    sameCount: stats.sameCount,
    diffCount: stats.diffCount,
    undeterminedCount: stats.undeterminedCount,
    distinctVerifierCount: stats.distinctVerifierCount,
    activeDiffVerifierCount: stats.activeDiffVerifierCount,
    lastVerdict: stats.lastVerdict,
    score: computeModelVerificationScore(stats),
    ...(exclusionThreshold !== undefined ? { exclusionThreshold } : {}),
  };
}

/**
 * True when a peer has a CORROBORATED standing substitution flag for the given
 * model — at least `minDistinctDiffVerifiers` distinct verifiers whose latest
 * verdict is DIFF. Historical (retracted) DIFFs do not flag; they only lower
 * the score ceiling.
 *
 * This is the EXCLUSION gate: consumers (DefaultRouter, the CLI buyer-proxy
 * 502/pinned-peer path) drop a peer from the candidate set when it returns
 * true, so it deliberately requires the same corroboration threshold as the
 * on-chain emissions penalty (see MIN_DISTINCT_DIFF_VERIFIERS_FOR_EXCLUSION).
 * A single standing DIFF (`activeDiffVerifierCount === 1`) is NOT enough to
 * exclude — it only deprioritizes via the authenticity score — so one wrong or
 * malicious verifier cannot unilaterally blackball an honest seller.
 *
 * The flag keys SOLELY on `activeDiffVerifierCount` — the exact on-chain field
 * the points penalty gates on and that owner remediation
 * (`clearVerifierStanding`) decrements. Routing must track it and nothing else,
 * or the two diverge: `clearVerifierStanding` never rewrites `stats.lastVerdict`
 * (only `submitAttestation` does), so keying on `lastVerdict === DIFF` would
 * leave routing blocked forever after an owner clear even though the economic
 * penalty had lifted.
 *
 * A `lastVerdict === DIFF` disjunct is deliberately NOT used. It is not a
 * graceful-degradation path for old deployments either: a registry predating
 * `activeDiffVerifierCount` returns a 6-field tuple that fails ABI decode
 * outright (the client declares 7 fields), so such a deployment yields no
 * verification data at all rather than stats with the field decoded as 0.
 */
export function hasModelSubstitutionFlag(
  mv: PeerModelVerification | undefined,
  minDistinctDiffVerifiers?: number,
): boolean {
  if (mv === undefined) return false;
  // Threshold precedence: an explicit caller override wins, then the
  // chain-read value stamped at enrichment time (`exclusionThreshold`), then
  // the offline fallback. The stamp is validated (persisted state can carry
  // arbitrary JSON): anything but an integer >= 1 — the contract setter's own
  // domain — is ignored rather than trusted.
  const stamped = mv.exclusionThreshold;
  const threshold = minDistinctDiffVerifiers
    ?? (typeof stamped === 'number' && Number.isInteger(stamped) && stamped >= 1
      ? stamped
      : MIN_DISTINCT_DIFF_VERIFIERS_FOR_EXCLUSION);
  return mv.activeDiffVerifierCount >= threshold;
}
