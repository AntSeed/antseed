/**
 * Built-in bank of numeric factual cloze probes and deterministic probe-set
 * generation for cohort-mode verification.
 *
 * Bank `consensus` values are ADVISORY: in cohort mode ground truth comes
 * from cross-seller consensus, so the bank values need not be certified-true.
 * They exist so reference-based flows and tests have plausible expectations.
 */

import { canonicalHash } from './canonical-json.js';
import { deriveHex } from './prng.js';
import {
  deterministicSample,
  staticProbeSource,
  type ProbeSource,
} from './probe-source.js';
import { computeProbeSetId, type KbfProbe, type ProbeSet, type ProbeTolerance } from './types.js';

function abs(value: number): ProbeTolerance {
  return { mode: 'absolute', value };
}

function rel(value: number): ProbeTolerance {
  return { mode: 'relative', value };
}

function probe(
  domain: string,
  slug: string,
  name: string,
  template: string,
  consensus: number,
  range: [number, number],
  tolerance: ProbeTolerance,
): KbfProbe {
  return { id: `${domain}:${slug}`, name, domain, template, consensus, range, tolerance };
}

/* eslint-disable max-len */
export const PROBE_BANK: readonly KbfProbe[] = [
  // -- chemistry: melting / boiling points (°C) ----------------------------
  probe('chemistry_mp', 'tungsten', 'tungsten', 'The melting point of tungsten is ___°C.', 3422, [-300, 4500], abs(30)),
  probe('chemistry_mp', 'tantalum-carbide', 'tantalum carbide', 'The melting point of tantalum carbide is ___°C.', 3880, [-300, 4500], abs(60)),
  probe('chemistry_mp', 'rhenium', 'rhenium', 'The melting point of rhenium is ___°C.', 3186, [-300, 4500], abs(30)),
  probe('chemistry_mp', 'osmium', 'osmium', 'The melting point of osmium is ___°C.', 3033, [-300, 4500], abs(30)),
  probe('chemistry_mp', 'iron', 'iron', 'The melting point of iron is ___°C.', 1538, [-300, 4500], abs(10)),
  probe('chemistry_mp', 'gold', 'gold', 'The melting point of gold is ___°C.', 1064, [-300, 4500], abs(5)),
  probe('chemistry_mp', 'silver', 'silver', 'The melting point of silver is ___°C.', 961.8, [-300, 4500], abs(5)),
  probe('chemistry_mp', 'copper', 'copper', 'The melting point of copper is ___°C.', 1084.6, [-300, 4500], abs(5)),
  probe('chemistry_mp', 'platinum', 'platinum', 'The melting point of platinum is ___°C.', 1768, [-300, 4500], abs(10)),
  probe('chemistry_mp', 'titanium', 'titanium', 'The melting point of titanium is ___°C.', 1668, [-300, 4500], abs(10)),
  probe('chemistry_mp', 'sodium-chloride', 'sodium chloride', 'The melting point of sodium chloride is ___°C.', 801, [-300, 4500], abs(5)),
  probe('chemistry_mp', 'ethanol-bp', 'ethanol', 'The boiling point of ethanol at standard pressure is ___°C.', 78.4, [-300, 4500], abs(1)),

  // -- physics: constants (scaled to convenient magnitudes) ----------------
  probe('physics_const', 'speed-of-light-kms', 'speed of light', 'The speed of light in vacuum is ___ km/s.', 299792.458, [0, 500000], abs(2)),
  probe('physics_const', 'standard-gravity', 'standard gravity', 'Standard gravity at the surface of the Earth is ___ m/s^2.', 9.80665, [0, 20], abs(0.02)),
  probe('physics_const', 'planck-e34', 'Planck constant', 'The Planck constant multiplied by 10^34 is ___ J*s.', 6.62607, [0, 100], rel(0.001)),
  probe('physics_const', 'elementary-charge-e19', 'elementary charge', 'The elementary charge multiplied by 10^19 is ___ C.', 1.602177, [0, 100], rel(0.001)),
  probe('physics_const', 'avogadro-em23', 'Avogadro constant', 'The Avogadro constant multiplied by 10^-23 is ___ per mole.', 6.02214, [0, 100], rel(0.001)),
  probe('physics_const', 'electron-mass-e31', 'electron mass', 'The electron rest mass multiplied by 10^31 is ___ kg.', 9.10938, [0, 100], rel(0.001)),
  probe('physics_const', 'proton-electron-ratio', 'proton-electron mass ratio', 'The proton-to-electron mass ratio is approximately ___.', 1836.15, [0, 10000], abs(0.5)),
  probe('physics_const', 'gas-constant', 'molar gas constant', 'The molar gas constant is ___ J/(mol*K).', 8.314, [0, 100], abs(0.01)),
  probe('physics_const', 'boltzmann-e23', 'Boltzmann constant', 'The Boltzmann constant multiplied by 10^23 is ___ J/K.', 1.380649, [0, 100], rel(0.001)),
  probe('physics_const', 'inverse-fine-structure', 'inverse fine-structure constant', 'The inverse of the fine-structure constant is approximately ___.', 137.036, [0, 1000], abs(0.05)),
  probe('physics_const', 'gravitational-e11', 'gravitational constant', 'The Newtonian gravitational constant multiplied by 10^11 is ___ m^3/(kg*s^2).', 6.674, [0, 100], abs(0.01)),
  probe('physics_const', 'absolute-zero-c', 'absolute zero', 'Absolute zero is ___°C.', -273.15, [-500, 0], abs(0.01)),

  // -- biology: diploid chromosome counts (2n) -----------------------------
  probe('biology_2n', 'human', 'human', 'The diploid chromosome number (2n) of humans is ___.', 46, [2, 500], abs(0)),
  probe('biology_2n', 'chimpanzee', 'chimpanzee', 'The diploid chromosome number (2n) of the chimpanzee is ___.', 48, [2, 500], abs(0)),
  probe('biology_2n', 'dog', 'dog', 'The diploid chromosome number (2n) of the domestic dog is ___.', 78, [2, 500], abs(0)),
  probe('biology_2n', 'cat', 'cat', 'The diploid chromosome number (2n) of the domestic cat is ___.', 38, [2, 500], abs(0)),
  probe('biology_2n', 'horse', 'horse', 'The diploid chromosome number (2n) of the horse is ___.', 64, [2, 500], abs(0)),
  probe('biology_2n', 'mouse', 'house mouse', 'The diploid chromosome number (2n) of the house mouse is ___.', 40, [2, 500], abs(0)),
  probe('biology_2n', 'fruit-fly', 'fruit fly', 'The diploid chromosome number (2n) of Drosophila melanogaster is ___.', 8, [2, 500], abs(0)),
  probe('biology_2n', 'chicken', 'chicken', 'The diploid chromosome number (2n) of the chicken is ___.', 78, [2, 500], abs(0)),
  probe('biology_2n', 'cattle', 'cattle', 'The diploid chromosome number (2n) of domestic cattle is ___.', 60, [2, 500], abs(0)),
  probe('biology_2n', 'pig', 'pig', 'The diploid chromosome number (2n) of the domestic pig is ___.', 38, [2, 500], abs(0)),
  probe('biology_2n', 'rice', 'rice', 'The diploid chromosome number (2n) of rice (Oryza sativa) is ___.', 24, [2, 500], abs(0)),
  probe('biology_2n', 'potato', 'potato', 'The chromosome number (4n) of the cultivated potato is ___.', 48, [2, 500], abs(0)),

  // -- astronomy: distances and periods -------------------------------------
  probe('astronomy', 'mars-orbital-days', 'Mars', 'The orbital period of Mars is ___ Earth days.', 687, [0, 100000], abs(3)),
  probe('astronomy', 'jupiter-orbital-years', 'Jupiter', 'The orbital period of Jupiter is ___ Earth years.', 11.86, [0, 1000], abs(0.15)),
  probe('astronomy', 'moon-distance-km', 'Moon', 'The mean distance from the Earth to the Moon is ___ km.', 384400, [0, 1000000], abs(2000)),
  probe('astronomy', 'mercury-orbital-days', 'Mercury', 'The orbital period of Mercury is ___ Earth days.', 87.97, [0, 100000], abs(1)),
  probe('astronomy', 'venus-orbital-days', 'Venus', 'The orbital period of Venus is ___ Earth days.', 224.7, [0, 100000], abs(2)),
  probe('astronomy', 'saturn-orbital-years', 'Saturn', 'The orbital period of Saturn is ___ Earth years.', 29.45, [0, 1000], abs(0.4)),
  probe('astronomy', 'proxima-distance-ly', 'Proxima Centauri', 'The distance from the Sun to Proxima Centauri is ___ light-years.', 4.24, [0, 1000], abs(0.05)),
  probe('astronomy', 'sun-radius-km', 'Sun', 'The equatorial radius of the Sun is approximately ___ km.', 695700, [0, 10000000], abs(5000)),
  probe('astronomy', 'earth-radius-km', 'Earth', 'The equatorial radius of the Earth is ___ km.', 6378, [0, 100000], abs(10)),
  probe('astronomy', 'halley-period-years', "Halley's comet", "The orbital period of Halley's comet is approximately ___ years.", 76, [0, 1000], abs(1.5)),
  probe('astronomy', 'sirius-distance-ly', 'Sirius', 'The distance from the Sun to Sirius is ___ light-years.', 8.6, [0, 1000], abs(0.2)),
  probe('astronomy', 'neptune-orbital-years', 'Neptune', 'The orbital period of Neptune is ___ Earth years.', 164.8, [0, 1000], abs(1.5)),

  // -- geography: elevations, depths, lengths -------------------------------
  probe('geography', 'everest-m', 'Mount Everest', 'The elevation of Mount Everest is ___ meters.', 8849, [-12000, 10000], abs(10)),
  probe('geography', 'k2-m', 'K2', 'The elevation of K2 is ___ meters.', 8611, [-12000, 10000], abs(10)),
  probe('geography', 'nile-km', 'Nile', 'The length of the Nile river is approximately ___ km.', 6650, [0, 10000], abs(150)),
  probe('geography', 'amazon-km', 'Amazon', 'The length of the Amazon river is approximately ___ km.', 6400, [0, 10000], abs(400)),
  probe('geography', 'dead-sea-m', 'Dead Sea', 'The surface elevation of the Dead Sea is ___ meters.', -430, [-12000, 10000], abs(15)),
  probe('geography', 'mont-blanc-m', 'Mont Blanc', 'The elevation of Mont Blanc is ___ meters.', 4808, [-12000, 10000], abs(10)),
  probe('geography', 'kilimanjaro-m', 'Kilimanjaro', 'The elevation of Mount Kilimanjaro is ___ meters.', 5895, [-12000, 10000], abs(10)),
  probe('geography', 'challenger-deep-m', 'Challenger Deep', 'The depth of the Challenger Deep in the Mariana Trench is approximately ___ meters.', 10935, [0, 12000], abs(120)),
  probe('geography', 'baikal-depth-m', 'Lake Baikal', 'The maximum depth of Lake Baikal is ___ meters.', 1642, [0, 12000], abs(20)),
  probe('geography', 'denali-m', 'Denali', 'The elevation of Denali is ___ meters.', 6190, [-12000, 10000], abs(15)),
  probe('geography', 'aconcagua-m', 'Aconcagua', 'The elevation of Aconcagua is ___ meters.', 6961, [-12000, 10000], abs(15)),
  probe('geography', 'panama-canal-km', 'Panama Canal', 'The length of the Panama Canal is approximately ___ km.', 82, [0, 10000], abs(3)),

  // -- math: constant digits ------------------------------------------------
  probe('math_const', 'pi-6dp', 'pi', 'The value of pi rounded to 6 decimal places is ___.', 3.141593, [0, 10], abs(0.000002)),
  probe('math_const', 'e-6dp', 'e', "The value of Euler's number e rounded to 6 decimal places is ___.", 2.718282, [0, 10], abs(0.000002)),
  probe('math_const', 'sqrt2-6dp', 'square root of 2', 'The square root of 2 rounded to 6 decimal places is ___.', 1.414214, [0, 10], abs(0.000002)),
  probe('math_const', 'golden-ratio-6dp', 'golden ratio', 'The golden ratio rounded to 6 decimal places is ___.', 1.618034, [0, 10], abs(0.000002)),
  probe('math_const', 'ln2-6dp', 'natural log of 2', 'The natural logarithm of 2 rounded to 6 decimal places is ___.', 0.693147, [0, 10], abs(0.000002)),
  probe('math_const', 'sqrt3-6dp', 'square root of 3', 'The square root of 3 rounded to 6 decimal places is ___.', 1.732051, [0, 10], abs(0.000002)),
  probe('math_const', 'pi-squared-4dp', 'pi squared', 'The value of pi squared rounded to 4 decimal places is ___.', 9.8696, [0, 100], abs(0.0002)),
  probe('math_const', 'log10-2-6dp', 'base-10 log of 2', 'The base-10 logarithm of 2 rounded to 6 decimal places is ___.', 0.30103, [0, 10], abs(0.000002)),
  probe('math_const', 'euler-mascheroni-6dp', 'Euler-Mascheroni constant', 'The Euler-Mascheroni constant rounded to 6 decimal places is ___.', 0.577216, [0, 10], abs(0.000002)),
  probe('math_const', 'catalan-6dp', 'Catalan constant', "The Catalan constant rounded to 6 decimal places is ___.", 0.915966, [0, 10], abs(0.000002)),
];
/* eslint-enable max-len */

export const PROBE_BANK_DOMAINS: readonly string[] = [...new Set(PROBE_BANK.map((p) => p.domain))];

export const PROBE_BANK_SOURCE_ID = 'bank/v1';

/**
 * The built-in bank as a ProbeSource. Its `consensus` values are advisory
 * (cohort consensus is the reference in production), so `consensusCertified`
 * is false. Intended for tests, demos, and bootstrap — production verifiers
 * should draw from a large rotating source such as `compositionalProbeSource`.
 */
export function probeBankSource(): ProbeSource {
  return staticProbeSource(PROBE_BANK_SOURCE_ID, PROBE_BANK);
}

// ---------------------------------------------------------------------------
// Deterministic probe-set generation
// ---------------------------------------------------------------------------

export interface GenerateProbeSetParams {
  service: string;
  count: number;
  /** Arbitrary seed string; same seed → identical probe set. */
  seed: string;
  /**
   * Probe origin. Defaults to the built-in bank. Pass `compositionalProbeSource()`
   * (or a reference-backed source) for a large rotating space.
   */
  source?: ProbeSource;
  /** Probe ids to skip (rotation). Forwarded to the source / bank selection. */
  exclude?: ReadonlySet<string>;
  /**
   * Restrict bank selection to these domains. Only applies to the default bank
   * path; ignored when an explicit `source` is given (a source owns its pool).
   */
  domains?: readonly string[];
  /**
   * Timestamp recorded on the probe set. Defaults to the current time; pass a
   * fixed value for byte-identical ProbeSets. Excluded from probeSetId and
   * probe commitments, so all hashed artifacts are seed-deterministic anyway.
   */
  createdAt?: string;
}

/**
 * Deterministically select and shuffle `count` probes and wrap them in a
 * committable ProbeSet. Same (source, seed, exclude) → identical selection and
 * order, so a probe set can be regenerated and verified later.
 *
 * With no `source`, probes are drawn from the built-in bank (optionally
 * filtered by `domains`), preserving the original behavior.
 */
export function generateProbeSet(params: GenerateProbeSetParams): ProbeSet {
  const { service, count, seed, source, exclude, domains } = params;

  let probes: KbfProbe[];
  if (source) {
    probes = source.generate({ count, seed, exclude });
  } else {
    const pool = domains ? PROBE_BANK.filter((p) => domains.includes(p.domain)) : PROBE_BANK;
    probes = deterministicSample(pool, { count, seed, exclude });
  }

  // Commitment blinding nonce, HKDF-derived (RFC 5869) from the seed under its
  // own domain tag so it can never collide with the RNG streams drawn from the
  // same seed. EVERYTHING that varies the generated probe set — the sorted
  // exclude set, the service, the count, the source id, and the bank-path
  // domains filter — is folded (canonically hashed) into the domain: any of
  // them changing changes the selection, so it must also change the nonce.
  // Otherwise the same seed with a grown exclude set (rotation) or a sibling
  // (service, count, source, domains) tuple would blind a DIFFERENT probe set
  // with the SAME nonce, and opening one audit's commitment would void the
  // sibling's blinding. The parameters are hashed rather than inlined because
  // hkdfSync caps `info` at 1024 bytes, which a deep rotation log would
  // exceed. Hiding rests on the seed being high-entropy and secret.
  //
  // The SAMPLING seed is deliberately left as the raw caller seed (not
  // per-service): two sets drawn from one seed for different (service, count)
  // still share a selection prefix, but with distinct nonces each commitment
  // stays independently blinded. Callers wanting disjoint selections must use
  // fresh per-audit seeds — which they should anyway for hiding.
  const excludeIds = exclude ? [...exclude].sort() : [];
  const nonceDomain = canonicalHash({
    service,
    count,
    source: source ? source.id : PROBE_BANK_SOURCE_ID,
    // Only the default bank path selects by domains; a source owns its pool
    // (sorted: order does not change the filtered selection).
    domains: !source && domains ? [...domains].sort() : null,
    exclude: excludeIds,
  });
  const nonce = deriveHex(seed, `probe-set-nonce/${nonceDomain}`);
  return {
    probeSetId: computeProbeSetId(service, probes),
    service,
    probes,
    nonce,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}
