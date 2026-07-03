/**
 * Match-vector computation: tolerance matching of parsed answers against
 * probe consensus values.
 */

import type { KbfProbe, MatchEntry, MatchVector } from '../../types.js';

/** True when `answer` is within the probe's tolerance of its consensus. */
export function matchesTolerance(answer: number, probe: KbfProbe): boolean {
  const { mode, value } = probe.tolerance;
  const diff = Math.abs(answer - probe.consensus);
  if (mode === 'absolute') {
    return diff <= value;
  }
  if (mode === 'relative') {
    return diff <= Math.abs(probe.consensus) * value;
  }
  throw new Error(`matchesTolerance: unknown tolerance mode "${String(mode)}"`);
}

/**
 * Score answers against probes: 1 within tolerance of consensus, 0 mismatch,
 * null for missing / non-finite / out-of-range answers (treated as
 * unparseable, not as mismatches).
 */
export function computeMatchVector(
  answers: ReadonlyArray<number | null>,
  probes: readonly KbfProbe[],
): MatchVector {
  if (answers.length !== probes.length) {
    throw new Error(
      `computeMatchVector: answers length ${answers.length} !== probes length ${probes.length}`,
    );
  }
  return probes.map((probe, i): MatchEntry => {
    const answer = answers[i];
    if (answer === null || answer === undefined || !Number.isFinite(answer)) {
      return null;
    }
    const [lo, hi] = probe.range;
    if (answer < lo || answer > hi) {
      return null;
    }
    return matchesTolerance(answer, probe) ? 1 : 0;
  });
}
