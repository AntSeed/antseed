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
// ---------------------------------------------------------------------------

/** Chemical elements — used for melting/boiling point and atomic number. */
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

/** Bodies with a well-defined orbital period around their primary. */
const ORBITAL_BODIES: readonly string[] = [
  'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus',
  'Neptune', 'Pluto', 'Ceres', 'Eris', 'Haumea', 'Makemake', 'Vesta',
  'Pallas', 'Hygiea', 'the Moon', 'Io', 'Europa', 'Ganymede', 'Callisto',
  'Titan', 'Enceladus', 'Triton', 'Phobos', 'Deimos', "Halley's comet",
  'comet Encke', 'the dwarf planet Sedna',
];

/** Mountains with a well-known summit elevation (metres). */
const MOUNTAINS: readonly string[] = [
  'Mount Everest', 'K2', 'Kangchenjunga', 'Lhotse', 'Makalu', 'Cho Oyu',
  'Dhaulagiri', 'Manaslu', 'Nanga Parbat', 'Annapurna', 'Gasherbrum I',
  'Broad Peak', 'Gasherbrum II', 'Shishapangma', 'Denali', 'Mount Logan',
  'Pico de Orizaba', 'Mount Kilimanjaro', 'Mount Kenya', 'Aconcagua',
  'Ojos del Salado', 'Monte Pissis', 'Mont Blanc', 'Monte Rosa', 'the Matterhorn',
  'Mount Elbrus', 'Mount Kosciuszko', 'Vinson Massif', 'Puncak Jaya',
  'Mount Rainier', 'Mount Whitney', 'Mount Fuji', 'Mount Etna', 'the Zugspitze',
];

/** Rivers with a well-known length (kilometres). */
const RIVERS: readonly string[] = [
  'Nile', 'Amazon', 'Yangtze', 'Mississippi', 'Yenisei', 'Yellow River',
  'Ob', 'Parana', 'Congo', 'Amur', 'Lena', 'Mekong', 'Mackenzie', 'Niger',
  'Murray', 'Volga', 'Indus', 'Danube', 'Euphrates', 'Ganges', 'Rio Grande',
  'Colorado River', 'Rhine', 'Seine', 'Thames', 'Po', 'Tigris', 'Columbia River',
];

/** Countries with a stable total land+water area (square kilometres). */
const COUNTRIES: readonly string[] = [
  'Russia', 'Canada', 'China', 'the United States', 'Brazil', 'Australia',
  'India', 'Argentina', 'Kazakhstan', 'Algeria', 'the Democratic Republic of the Congo',
  'Saudi Arabia', 'Mexico', 'Indonesia', 'Sudan', 'Libya', 'Iran', 'Mongolia',
  'Peru', 'Chad', 'Niger', 'Angola', 'Mali', 'South Africa', 'Colombia',
  'Ethiopia', 'Bolivia', 'Mauritania', 'Egypt', 'Tanzania', 'Nigeria',
  'Venezuela', 'Namibia', 'Mozambique', 'Turkey', 'Chile', 'Zambia', 'France',
  'Spain', 'Thailand', 'Sweden', 'Japan', 'Germany', 'Norway', 'Poland', 'Italy',
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
    entities: ELEMENTS,
  },
  {
    domain: 'element_bp',
    property: 'boiling point',
    template: 'The boiling point of {name} is ___°C.',
    range: [-270, 6000],
    tolerance: abs(60),
    entities: ELEMENTS,
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
    tolerance: abs(15),
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
    tolerance: rel(0.03),
    entities: COUNTRIES,
  },
];
