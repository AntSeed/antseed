import { describe, expect, it } from 'vitest';
import { COMPOSITIONAL_SCHEMAS, type AttributeSchema } from '../src/compositional/dataset.js';
import { compositionalProbeSource } from '../src/compositional/source.js';
import { computeCohortConsensus } from '../src/cohort.js';
import { matchesTolerance } from '../src/verifiers/kbf/scoring.js';
import type { KbfProbe, SellerObservation } from '../src/types.js';

function schema(domain: string): AttributeSchema {
  const found = COMPOSITIONAL_SCHEMAS.find((s) => s.domain === domain);
  expect(found, domain).toBeDefined();
  return found!;
}

// The UNAMBIGUITY REQUIREMENT (dataset.ts): every (entity, attribute) pair
// must have a single widely-cited value within the schema tolerance. These
// tests pin the corrections for entities that violated it.
describe('compositional dataset — unambiguity corrections', () => {
  it('element_mp excludes elements without a well-defined 1-atm melting point', () => {
    const mp = schema('element_mp');
    // helium never solidifies at 1 atm (and its pressurized ≈−272 °C sat
    // below the range floor); carbon and arsenic sublime at 1 atm.
    for (const banned of ['helium', 'carbon', 'arsenic']) {
      expect(mp.entities, banned).not.toContain(banned);
    }
    // Replacements keep the pool size stable.
    for (const added of ['neodymium', 'samarium', 'gadolinium']) {
      expect(mp.entities, added).toContain(added);
    }
    expect(mp.entities.length).toBe(71);
    // Boiling point and atomic number keep the full element list — helium's
    // 1-atm boiling point (≈−269 °C) and atomic number are well-defined.
    expect(schema('element_bp').entities).toContain('helium');
    expect(schema('element_z').entities).toContain('helium');
  });

  it('element_mp range floor covers the coldest remaining melting point (hydrogen ≈ −259 °C)', () => {
    expect(schema('element_mp').range[0]).toBeLessThanOrEqual(-260);
  });

  it('element_bp excludes elements that sublime rather than boil at 1 atm', () => {
    const bp = schema('element_bp');
    // carbon (sublimes ≈3642 °C) and arsenic (sublimes ≈614 °C) have no
    // well-defined 1-atm boiling point — same ambiguity class as MP_ELEMENTS.
    for (const banned of ['carbon', 'arsenic']) {
      expect(bp.entities, banned).not.toContain(banned);
    }
    // Helium is KEPT here (its 1-atm boiling point ≈−269 °C is sharp), unlike
    // element_mp where helium never solidifies at 1 atm.
    expect(bp.entities).toContain('helium');
    // Refractory-lanthanide replacements keep the pool size stable at 71.
    for (const added of ['neodymium', 'gadolinium']) {
      expect(bp.entities, added).toContain(added);
    }
    expect(bp.entities.length).toBe(71);
    // The atomic-number schema is unaffected: carbon (Z=6) and arsenic (Z=33)
    // have unambiguous atomic numbers and stay in the full element list.
    expect(schema('element_z').entities).toContain('carbon');
    expect(schema('element_z').entities).toContain('arsenic');
  });

  it('river_len excludes rivers with competing headwater/system figures', () => {
    const rivers = schema('river_len');
    // Each dropped river has honest full-system vs main-stem figures spread
    // 13–144% apart — far beyond the 5% relative tolerance.
    for (const banned of ['Ob', 'Amur', 'Mackenzie', 'Mekong']) {
      expect(rivers.entities, banned).not.toContain(banned);
    }
    for (const added of ['Rhone', 'Vistula', 'Douro', 'Ohio River']) {
      expect(rivers.entities, added).toContain(added);
    }
    expect(rivers.entities.length).toBe(28);
  });

  it('country_area excludes countries with territorial-scope ambiguity', () => {
    const countries = schema('country_area');
    // Norway ±19% (Svalbard/Jan Mayen), France ±17% (overseas territories) —
    // both exceed the 12% relative tolerance.
    for (const banned of ['Norway', 'France']) {
      expect(countries.entities, banned).not.toContain(banned);
    }
    for (const added of ['Madagascar', 'Kenya']) {
      expect(countries.entities, added).toContain(added);
    }
    expect(countries.entities.length).toBe(46);
  });

  it('mountain_elev drops Mount Etna and covers both honest Makalu survey figures', () => {
    const mountains = schema('mountain_elev');
    // Etna's summit moves with eruptions — no stable honest figure.
    expect(mountains.entities).not.toContain('Mount Etna');
    expect(mountains.entities).toContain('Ben Nevis');
    expect(mountains.entities.length).toBe(34);
    // Makalu: 8,485 m (modern survey) vs 8,463 m (traditional) are 22 m
    // apart; the tolerance must merge them into one consensus cluster.
    expect(mountains.tolerance).toEqual({ mode: 'absolute', value: 25 });
    expect(Math.abs(8485 - 8463)).toBeLessThanOrEqual(mountains.tolerance.value);
  });

  it('keeps the overall pool size stable after the replacements', () => {
    expect(compositionalProbeSource().size).toBe(350);
  });
});

// ---------------------------------------------------------------------------
// Known-truth spot checks: for a sample of (entity, attribute) pairs with
// well-established real-world values, the schema must satisfy the invariant
// the file's own header demands — the range CONTAINS the truth (else every
// honest answer is rejected as unparseable and the probe can never form
// consensus), and every honest published variant sits within the tolerance
// of the truth (else honest sellers split into sub-tolerance camps).
// ---------------------------------------------------------------------------

interface KnownTruth {
  domain: string;
  entity: string;
  /** The single widely-cited true value. */
  truth: number;
  /** Other honest published figures (surveys, conventions, roundings). */
  variants: number[];
}

const KNOWN_TRUTHS: readonly KnownTruth[] = [
  // element_mp — including the coldest survivor (hydrogen) and the three
  // lanthanide replacements for helium/carbon/arsenic.
  { domain: 'element_mp', entity: 'hydrogen', truth: -259.16, variants: [-259.14, -259.2, -259] },
  { domain: 'element_mp', entity: 'tungsten', truth: 3422, variants: [3410, 3414, 3422] },
  { domain: 'element_mp', entity: 'neodymium', truth: 1024, variants: [1021, 1024] },
  { domain: 'element_mp', entity: 'samarium', truth: 1072, variants: [1072, 1074] },
  { domain: 'element_mp', entity: 'gadolinium', truth: 1313, variants: [1312, 1313] },
  // element_bp — helium stays here (its 1-atm boiling point IS well-defined)
  // and must clear the range floor; carbon/arsenic are excluded (they sublime),
  // replaced by two refractory lanthanides with sharp 1-atm boiling points.
  { domain: 'element_bp', entity: 'helium', truth: -268.93, variants: [-268.9, -269] },
  { domain: 'element_bp', entity: 'neodymium', truth: 3074, variants: [3074, 3027] },
  { domain: 'element_bp', entity: 'gadolinium', truth: 3273, variants: [3273, 3266] },
  { domain: 'orbital_period', entity: 'Mars', truth: 686.98, variants: [687] },
  // river_len — the four replacements plus a survivor.
  { domain: 'river_len', entity: 'Rhone', truth: 813, variants: [812, 813] },
  { domain: 'river_len', entity: 'Vistula', truth: 1047, variants: [1047, 1070] },
  { domain: 'river_len', entity: 'Douro', truth: 897, variants: [895, 897] },
  { domain: 'river_len', entity: 'Ohio River', truth: 1579, variants: [1575, 1579] },
  { domain: 'river_len', entity: 'Nile', truth: 6650, variants: [6650, 6695] },
  // country_area — the two replacements (land-only vs land+water variants
  // must stay in one cluster under the 12% tolerance).
  { domain: 'country_area', entity: 'Madagascar', truth: 587041, variants: [581540, 587041] },
  { domain: 'country_area', entity: 'Kenya', truth: 580367, variants: [569140, 582646] },
  // mountain_elev — the replacement, the two-survey Makalu case the abs(25)
  // tolerance exists for, and Everest's 2020 vs traditional figures.
  { domain: 'mountain_elev', entity: 'Ben Nevis', truth: 1345, variants: [1344, 1345] },
  { domain: 'mountain_elev', entity: 'Makalu', truth: 8485, variants: [8463, 8485] },
  { domain: 'mountain_elev', entity: 'Mount Everest', truth: 8849, variants: [8848, 8848.86] },
];

function probeFor(s: AttributeSchema, entity: string, consensus: number): KbfProbe {
  return {
    id: `comp:${s.domain}:known-truth`,
    name: entity,
    domain: s.domain,
    template: s.template.split('{name}').join(entity),
    consensus,
    range: s.range,
    tolerance: s.tolerance,
  };
}

describe('compositional dataset — known-truth invariants', () => {
  it.each(KNOWN_TRUTHS.map((k) => [`${k.domain}:${k.entity}`, k] as const))(
    '%s: range contains the truth and honest variants agree within tolerance',
    (_label, k) => {
      const s = schema(k.domain);
      expect(s.entities).toContain(k.entity);
      expect(k.truth).toBeGreaterThanOrEqual(s.range[0]);
      expect(k.truth).toBeLessThanOrEqual(s.range[1]);
      const probe = probeFor(s, k.entity, k.truth);
      for (const variant of k.variants) {
        expect(variant, `variant ${variant} outside range`).toBeGreaterThanOrEqual(s.range[0]);
        expect(variant, `variant ${variant} outside range`).toBeLessThanOrEqual(s.range[1]);
        expect(
          matchesTolerance(variant, probe),
          `variant ${variant} outside tolerance of ${k.truth}`,
        ).toBe(true);
      }
    },
  );

  it('an honest cohort forms a consensus inside the range and within tolerance of reality', () => {
    // Five honest sellers answering the published figures (cycled) must
    // produce, for EVERY known-truth probe, a non-null consensus that lies in
    // the schema range and within tolerance of the true value — the exact
    // property the flagged entries (helium mp, Ob, France, Etna…) violated.
    const probes = KNOWN_TRUTHS.map((k) => probeFor(schema(k.domain), k.entity, k.truth));
    const observations: SellerObservation[] = Array.from({ length: 5 }, (_, s) => ({
      sellerPeerId: `0xhonest${s}`,
      agentId: s + 1,
      answers: KNOWN_TRUTHS.map((k) => {
        const pool = [k.truth, ...k.variants];
        return pool[s % pool.length]!;
      }),
      requestIds: [`req-${s}`],
    }));

    const consensus = computeCohortConsensus(observations, probes);
    for (let i = 0; i < probes.length; i++) {
      const k = KNOWN_TRUTHS[i]!;
      const value = consensus.values[i];
      expect(value, `${k.domain}:${k.entity} formed no consensus`).not.toBeNull();
      expect(value!).toBeGreaterThanOrEqual(probes[i]!.range[0]);
      expect(value!).toBeLessThanOrEqual(probes[i]!.range[1]);
      expect(
        matchesTolerance(value!, probes[i]!),
        `${k.domain}:${k.entity} consensus ${value} not within tolerance of ${k.truth}`,
      ).toBe(true);
    }
    expect(consensus.validProbeIndices).toHaveLength(probes.length);
  });
});
