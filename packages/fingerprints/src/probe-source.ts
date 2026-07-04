/**
 * ProbeSource — the pluggable origin of the probes a verifier commits and
 * sends each audit round.
 *
 * A static bank checked into source ossifies the moment it is published: a
 * cheating seller memorizes the finite set and routes exactly those questions
 * to the real model (spec 07, "Behavioral Probes … A static probe bank
 * published in this repository ossifies the moment it is public"). Abstracting
 * the origin lets the daemon draw from a large, rotating space instead — while
 * the static bank stays available as a test/bootstrap fixture.
 *
 * The unlock is cohort consensus: ground truth comes from the honest majority
 * at runtime, not from curated per-probe answers, so a source only needs
 * plausible entities, ranges, and tolerances — never certified values. That
 * makes an effectively unbounded probe space cheap to generate.
 */

import type { KbfProbe } from './types.js';
import { createRng } from './prng.js';

export interface ProbeGenerateParams {
  /** Number of probes to return. */
  count: number;
  /** Arbitrary seed; same seed + same source + same exclude → identical set. */
  seed: string;
  /**
   * Probe ids to skip (rotation). A source SHOULD NOT return any probe whose
   * id is present here, so a probe already revealed against a cohort is not
   * reused until the exclusion set is cycled.
   */
  exclude?: ReadonlySet<string>;
}

export interface ProbeSource {
  /** Stable identifier recorded for provenance (e.g. "compositional/v1"). */
  readonly id: string;
  /** Total distinct probes this source can produce, ignoring `exclude`. */
  readonly size: number;
  /**
   * Whether the probes carry certified `consensus` answers (reference mode) or
   * advisory placeholders scored only by cohort consensus. Reference-based
   * verdicts MUST NOT be computed against a source with `consensusCertified`
   * false — its `consensus` values are not ground truth.
   */
  readonly consensusCertified: boolean;
  generate(params: ProbeGenerateParams): KbfProbe[];
}

/**
 * Deterministically pick `count` probes from `pool`, honoring `exclude`.
 *
 * Excluded ids are removed BEFORE selection so rotation shrinks the live pool
 * rather than silently returning fewer probes; then a Fisher–Yates shuffle
 * driven by the HKDF/HMAC_DRBG deterministic RNG fixes selection and order.
 * Same (pool, seed, exclude) → identical output.
 */
export function deterministicSample(
  pool: readonly KbfProbe[],
  params: ProbeGenerateParams,
): KbfProbe[] {
  const { count, seed, exclude } = params;
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`deterministicSample: count must be a positive integer, got ${count}`);
  }
  const live = exclude && exclude.size > 0 ? pool.filter((p) => !exclude.has(p.id)) : [...pool];
  if (count > live.length) {
    throw new Error(
      `deterministicSample: count ${count} exceeds available probes ${live.length}` +
        (exclude && exclude.size > 0 ? ` (after excluding ${exclude.size})` : ''),
    );
  }

  return createRng(seed, 'probe-set').shuffle(live).slice(0, count);
}

/**
 * A ProbeSource backed by a fixed list of probes (the built-in bank, or a
 * reference's certified probes). `consensusCertified` distinguishes the two:
 * the bank's `consensus` values are advisory, a reference's are ground truth.
 */
export function staticProbeSource(
  id: string,
  probes: readonly KbfProbe[],
  options: { consensusCertified?: boolean } = {},
): ProbeSource {
  const frozen = [...probes];
  return {
    id,
    size: frozen.length,
    consensusCertified: options.consensusCertified ?? false,
    generate: (params) => deterministicSample(frozen, params),
  };
}
