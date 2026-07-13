/**
 * Compositional probe dataset: entities × numeric attributes.
 *
 * This is NOT a table of certified answers. Cohort consensus supplies ground
 * truth at runtime, so a schema only needs:
 *   - a large list of real entities,
 *   - a plausible numeric `range` (used to reject unparseable/garbage answers),
 *   - a `tolerance` (the clustering width for consensus).
 *
 * The probe space is |entities| across every schema — hundreds to low
 * thousands from compact tables, versus the ~70 hand-written bank entries.
 * That kills "memorize the finite bank" as a seller defense and gives the
 * rotation log room to never reuse a probe against the same cohort. It does
 * NOT by itself defeat a seller that classifies by request *shape* and routes
 * all short factual questions to the real model — that is the stealth engine's
 * job (shape diversity) and, ultimately, scoring genuinely organic traffic.
 */

import type { ProbeTolerance } from '../types.js';

export interface AttributeSchema {
  /** Probe domain / id namespace, e.g. "element_mp". */
  domain: string;
  /** Human property name inserted into the template, e.g. "melting point". */
  property: string;
  /**
   * Cloze template with `{name}` and a single `___`. Kept in the bank's
   * `The <property> of <name> is [approximately] ___<unit>.` shape so the
   * stealth transformer and free-text extractor handle it unchanged.
   */
  template: string;
  /** Plausible value bounds; answers outside are treated as unparseable. */
  range: [number, number];
  /** Consensus clustering width. */
  tolerance: ProbeTolerance;
  /** Entities this attribute applies to. */
  entities: readonly string[];
}

function abs(value: number): ProbeTolerance {
  return { mode: 'absolute', value };
}
function rel(value: number): ProbeTolerance {
  return { mode: 'relative', value };
}

// ---------------------------------------------------------------------------
// Entity tables (facts are stable; exact values are supplied by the cohort)
//
// UNAMBIGUITY REQUIREMENT: every (entity, attribute) pair must have a single
// widely-cited value within the schema tolerance. If two honest readings
// differ by more than the tolerance (sidereal vs synodic month, competing
// river-length surveys), honest sellers split into sub-tolerance camps and the
// probe either fails to form consensus or falsely flags honest sellers —
// either drop the entity or widen the tolerance to cover both readings.
// ---------------------------------------------------------------------------

/**
 * Chemical elements — used directly for the atomic-number schema, and as the
 * base list from which the melting-point (MP_ELEMENTS) and boiling-point
 * (BP_ELEMENTS) subsets are derived.
 */
const ELEMENTS: readonly string[] = [
  'hydrogen', 'helium', 'lithium', 'beryllium', 'boron', 'carbon', 'nitrogen',
  'oxygen', 'fluorine', 'neon', 'sodium', 'magnesium', 'aluminium', 'silicon',
  'phosphorus', 'sulfur', 'chlorine', 'argon', 'potassium', 'calcium',
  'scandium', 'titanium', 'vanadium', 'chromium', 'manganese', 'iron',
  'cobalt', 'nickel', 'copper', 'zinc', 'gallium', 'germanium', 'arsenic',
  'selenium', 'bromine', 'krypton', 'rubidium', 'strontium', 'yttrium',
  'zirconium', 'niobium', 'molybdenum', 'ruthenium', 'rhodium', 'palladium',
  'silver', 'cadmium', 'indium', 'tin', 'antimony', 'tellurium', 'iodine',
  'xenon', 'caesium', 'barium', 'lanthanum', 'cerium', 'tungsten', 'rhenium',
  'osmium', 'iridium', 'platinum', 'gold', 'mercury', 'thallium', 'lead',
  'bismuth', 'thorium', 'uranium', 'tantalum', 'hafnium',
];

/**
 * Elements with a well-defined 1-atm melting point. Deliberately absent from
 * ELEMENTS for the melting-point schema only:
 *  - helium: does not solidify at 1 atm at any temperature (needs ~25 atm);
 *    the commonly cited ≈−272 °C is a pressurized figure, and it also sat
 *    below the schema's range floor, so every honest answer was rejected.
 *  - carbon: sublimes at 1 atm; honest sources quote sublimation (~3642 °C)
 *    vs high-pressure melting (~3550 °C, graphite) vs diamond figures —
 *    spreads far beyond the abs(40) tolerance.
 *  - arsenic: sublimes at 1 atm (~615 °C) and melts only under pressure
 *    (817 °C at ~28 atm), so honest answers split across both conventions.
 * Replaced with lanthanides whose melting points are unambiguous single
 * figures well inside abs(40): neodymium ≈1024 °C, samarium ≈1072 °C,
 * gadolinium ≈1313 °C (cross-source spreads of a few °C).
 */
const MP_ELEMENTS: readonly string[] = [
  ...ELEMENTS.filter((e) => e !== 'helium' && e !== 'carbon' && e !== 'arsenic'),
  'neodymium', 'samarium', 'gadolinium',
];

/**
 * Elements with a well-defined 1-atm boiling point. Same sublimation-ambiguity
 * class as MP_ELEMENTS: carbon and arsenic are absent because at 1 atm they
 * SUBLIME rather than boil, so a cited "boiling point" is either a sublimation
 * temperature or a pressure-extrapolated figure, and honest sources diverge far
 * beyond the abs(60) tolerance:
 *  - carbon: sublimes ≈3642 °C at 1 atm; "boiling point" figures are
 *    extrapolated/high-pressure and spread across hundreds of °C.
 *  - arsenic: sublimes ≈614 °C at 1 atm and has no true 1-atm boiling point;
 *    honest sources quote either the sublimation point or pressurized figures.
 * Helium is KEPT here (unlike MP_ELEMENTS, where it never solidifies at 1 atm):
 * its 1-atm boiling point ≈−269 °C is a sharp, unambiguous figure inside range.
 * Replaced with refractory lanthanides whose boiling points are single
 * widely-cited figures well inside abs(60): neodymium ≈3074 °C,
 * gadolinium ≈3273 °C (cross-source spreads of a few °C).
 */
const BP_ELEMENTS: readonly string[] = [
  ...ELEMENTS.filter((e) => e !== 'carbon' && e !== 'arsenic'),
  'neodymium', 'gadolinium',
];

/**
 * Bodies with a well-defined orbital period around their primary.
 * "the Moon" is deliberately absent: its sidereal (27.3 d) and synodic
 * (29.5 d) periods are both honest answers ~8% apart — far beyond the 2%
 * relative tolerance.
 */
const ORBITAL_BODIES: readonly string[] = [
  'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus',
  'Neptune', 'Pluto', 'Ceres', 'Eris', 'Haumea', 'Makemake', 'Vesta',
  'Pallas', 'Hygiea', 'Charon', 'Io', 'Europa', 'Ganymede', 'Callisto',
  'Titan', 'Enceladus', 'Triton', 'Phobos', 'Deimos', "Halley's comet",
  'comet Encke', 'the dwarf planet Sedna',
];

/**
 * Mountains with a well-known summit elevation (metres).
 * "Mount Etna" is deliberately absent: it is an active volcano whose summit
 * height moves with every major eruption (~3,320–3,360 m across recent
 * surveys), so honest sources disagree by more than the tolerance.
 * "Makalu" is kept, but note its two honest figures (8,485 m modern survey vs
 * the traditional 8,463 m) sit 22 m apart — the schema tolerance is abs(25)
 * partly to keep both readings in one consensus cluster.
 */
const MOUNTAINS: readonly string[] = [
  'Mount Everest', 'K2', 'Kangchenjunga', 'Lhotse', 'Makalu', 'Cho Oyu',
  'Dhaulagiri', 'Manaslu', 'Nanga Parbat', 'Annapurna', 'Gasherbrum I',
  'Broad Peak', 'Gasherbrum II', 'Shishapangma', 'Denali', 'Mount Logan',
  'Pico de Orizaba', 'Mount Kilimanjaro', 'Mount Kenya', 'Aconcagua',
  'Ojos del Salado', 'Monte Pissis', 'Mont Blanc', 'Monte Rosa', 'the Matterhorn',
  'Mount Elbrus', 'Mount Kosciuszko', 'Vinson Massif', 'Puncak Jaya',
  'Mount Rainier', 'Mount Whitney', 'Mount Fuji', 'Ben Nevis', 'the Zugspitze',
];

/**
 * Rivers with a well-known length (kilometres).
 * Deliberately absent — each has competing honest headwater/system figures
 * spread beyond the 5% relative tolerance, so honest sellers would split into
 * sub-tolerance camps (the same reason as the classic Amazon dispute):
 *  - "Amazon": traditional ~6,400 km vs Ucayali-source ~6,992 km (~9%).
 *  - "Ob": ~3,650 km alone vs ~5,410 km as Ob–Irtysh (~48%).
 *  - "Amur": ~2,824 km alone vs ~4,444 km with Argun/Kherlen headwaters (~57%).
 *  - "Mackenzie": ~1,738 km alone vs ~4,241 km as Mackenzie–Slave–Peace–Finlay
 *    (~144%).
 *  - "Mekong": commonly cited figures range ~4,350–4,909 km (~13%).
 * Replacements (Rhone ≈813 km, Vistula ≈1,047 km, Douro ≈897 km, Ohio River
 * ≈1,579 km) each have a single widely-cited full-course figure with no
 * competing source convention.
 */
const RIVERS: readonly string[] = [
  'Nile', 'Loire', 'Yangtze', 'Mississippi', 'Yenisei', 'Yellow River',
  'Rhone', 'Parana', 'Congo', 'Vistula', 'Lena', 'Douro', 'Ohio River', 'Niger',
  'Murray', 'Volga', 'Indus', 'Danube', 'Euphrates', 'Ganges', 'Rio Grande',
  'Colorado River', 'Rhine', 'Seine', 'Thames', 'Po', 'Tigris', 'Columbia River',
];

/**
 * Countries with a stable total land+water area (square kilometres).
 * Deliberately absent — honest sources differ by more than the 12% tolerance
 * depending on which territories are counted:
 *  - "France": metropolitan ~551,695 km² vs including overseas territories
 *    ~643,801 km² (~17%).
 *  - "Norway": mainland ~323,808 km² vs including Svalbard and Jan Mayen
 *    ~385,207 km² (~19%).
 * Replacements (Madagascar ≈587,041 km², Kenya ≈580,367 km²) are contiguous
 * states with a single widely-cited figure and no territorial ambiguity.
 */
const COUNTRIES: readonly string[] = [
  'Russia', 'Canada', 'China', 'the United States', 'Brazil', 'Australia',
  'India', 'Argentina', 'Kazakhstan', 'Algeria', 'the Democratic Republic of the Congo',
  'Saudi Arabia', 'Mexico', 'Indonesia', 'Sudan', 'Libya', 'Iran', 'Mongolia',
  'Peru', 'Chad', 'Niger', 'Angola', 'Mali', 'South Africa', 'Colombia',
  'Ethiopia', 'Bolivia', 'Mauritania', 'Egypt', 'Tanzania', 'Nigeria',
  'Venezuela', 'Namibia', 'Mozambique', 'Turkey', 'Chile', 'Zambia', 'Madagascar',
  'Spain', 'Thailand', 'Sweden', 'Japan', 'Germany', 'Kenya', 'Poland', 'Italy',
];

// ---------------------------------------------------------------------------
// Attribute schemas
// ---------------------------------------------------------------------------

export const COMPOSITIONAL_SCHEMAS: readonly AttributeSchema[] = [
  {
    domain: 'element_mp',
    property: 'melting point',
    template: 'The melting point of {name} is ___°C.',
    range: [-260, 4000],
    tolerance: abs(40),
    // Not ELEMENTS: helium/carbon/arsenic have no well-defined 1-atm melting
    // point (see MP_ELEMENTS).
    entities: MP_ELEMENTS,
  },
  {
    domain: 'element_bp',
    property: 'boiling point',
    template: 'The boiling point of {name} is ___°C.',
    range: [-270, 6000],
    tolerance: abs(60),
    // Not ELEMENTS: carbon/arsenic sublime at 1 atm and have no well-defined
    // 1-atm boiling point (see BP_ELEMENTS). Helium stays — its 1-atm boiling
    // point is sharp — so this differs from MP_ELEMENTS only by keeping helium.
    entities: BP_ELEMENTS,
  },
  {
    domain: 'element_z',
    property: 'atomic number',
    template: 'The atomic number of {name} is ___.',
    range: [1, 120],
    tolerance: abs(0),
    entities: ELEMENTS,
  },
  {
    domain: 'orbital_period',
    property: 'orbital period',
    template: 'The orbital period of {name} is ___ Earth days.',
    range: [0, 12_000_000],
    tolerance: rel(0.02),
    entities: ORBITAL_BODIES,
  },
  {
    domain: 'mountain_elev',
    property: 'elevation',
    template: 'The elevation of {name} is ___ meters.',
    range: [0, 9000],
    // 25 m (up from 15) so summits with two honest survey figures stay in one
    // consensus cluster — Makalu's modern 8,485 m vs traditional 8,463 m are
    // 22 m apart. Neighbouring peaks differ by hundreds of metres, so the
    // wider width costs no discrimination.
    tolerance: abs(25),
    entities: MOUNTAINS,
  },
  {
    domain: 'river_len',
    property: 'length',
    template: 'The length of the {name} is approximately ___ km.',
    range: [0, 7500],
    tolerance: rel(0.05),
    entities: RIVERS,
  },
  {
    domain: 'country_area',
    property: 'total area',
    template: 'The total area of {name} is approximately ___ square kilometers.',
    range: [0, 20_000_000],
    // Wide on purpose: land-only vs land+water figures are both honest
    // readings of "area" and differ by up to ~11% for water-rich countries
    // (Canada, the United States, India, Sweden). 12% covers both camps in one
    // consensus cluster while still rejecting a substitute that is wrong about
    // which country is how big.
    tolerance: rel(0.12),
    entities: COUNTRIES,
  },
];
