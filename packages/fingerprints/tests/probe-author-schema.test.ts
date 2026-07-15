import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify, sha256Hex } from '../src/canonical-json.js';
import {
  BANNED_VOLATILE_PATTERNS,
  computeLlmProbeId,
  LLM_TEMPLATE_MAX_LENGTH,
  LLM_TEMPLATE_MIN_LENGTH,
  validateCandidateProbe,
  validateCandidateProbes,
} from '../src/probe-author-schema.js';

/** A fully valid candidate; tests clone and break one field at a time. */
function validCandidate(): Record<string, unknown> {
  return {
    name: 'tungsten melting point',
    domain: 'Chemistry MP',
    template: 'The melting point of tungsten is ___ degrees Celsius.',
    consensus: 3422,
    range: [3000, 4000],
    tolerance: { mode: 'absolute', value: 30 },
  };
}

function expectRejection(candidate: unknown, reasonPattern: RegExp): void {
  const result = validateCandidateProbe(candidate);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toMatch(reasonPattern);
  }
}

describe('validateCandidateProbe', () => {
  it('accepts a valid candidate and builds the probe from validated fields', () => {
    const result = validateCandidateProbe(validCandidate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe).toEqual({
      id: computeLlmProbeId('Chemistry MP', 'The melting point of tungsten is ___ degrees Celsius.'),
      name: 'tungsten melting point',
      domain: 'Chemistry MP',
      template: 'The melting point of tungsten is ___ degrees Celsius.',
      consensus: 3422,
      range: [3000, 4000],
      tolerance: { mode: 'absolute', value: 30 },
    });
    expect(result.probe.id).toMatch(/^llm:chemistry-mp:[0-9a-f]{12}$/);
  });

  it('accepts relative tolerance up to and including 1', () => {
    const candidate = { ...validCandidate(), tolerance: { mode: 'relative', value: 1 } };
    const result = validateCandidateProbe(candidate);
    expect(result.ok).toBe(true);
  });

  it('accepts consensus exactly at a range bound', () => {
    const atLo = validateCandidateProbe({ ...validCandidate(), range: [3422, 4000] });
    const atHi = validateCandidateProbe({ ...validCandidate(), range: [3000, 3422] });
    expect(atLo.ok).toBe(true);
    expect(atHi.ok).toBe(true);
  });

  it('accepts a template of exactly the minimum length', () => {
    const template = 'X is ___ meters tall'; // exactly 20 chars
    expect(template).toHaveLength(LLM_TEMPLATE_MIN_LENGTH);
    const result = validateCandidateProbe({ ...validCandidate(), template });
    expect(result.ok).toBe(true);
  });

  it('rejects non-object candidates', () => {
    expectRejection(null, /plain object/);
    expectRejection(undefined, /plain object/);
    expectRejection('probe', /plain object/);
    expectRejection(42, /plain object/);
    expectRejection([validCandidate()], /plain object/);
  });

  it('rejects missing, empty, or non-string name', () => {
    const { name: _n, ...noName } = validCandidate();
    expectRejection(noName, /name must be a non-empty string/);
    expectRejection({ ...validCandidate(), name: '' }, /name must be a non-empty string/);
    expectRejection({ ...validCandidate(), name: '   ' }, /name must be a non-empty string/);
    expectRejection({ ...validCandidate(), name: 7 }, /name must be a non-empty string/);
  });

  it('rejects missing, empty, or non-string domain', () => {
    const { domain: _d, ...noDomain } = validCandidate();
    expectRejection(noDomain, /domain must be a non-empty string/);
    expectRejection({ ...validCandidate(), domain: '' }, /domain must be a non-empty string/);
    expectRejection({ ...validCandidate(), domain: ['x'] }, /domain must be a non-empty string/);
  });

  it('rejects a domain with no alphanumeric characters (empty slug)', () => {
    expectRejection({ ...validCandidate(), domain: '!!!' }, /alphanumeric/);
  });

  it('rejects non-string template', () => {
    expectRejection({ ...validCandidate(), template: 123 }, /template must be a string/);
    const { template: _t, ...noTemplate } = validCandidate();
    expectRejection(noTemplate, /template must be a string/);
  });

  it('rejects a template without the ___ cloze marker', () => {
    expectRejection(
      { ...validCandidate(), template: 'The melting point of tungsten is 3422 C.' },
      /___ cloze marker/,
    );
  });

  it('rejects templates outside the 20..500 length bounds', () => {
    expectRejection({ ...validCandidate(), template: 'It is ___ ok.' }, /template length/);
    const long = `The value is ___ in ${'x'.repeat(LLM_TEMPLATE_MAX_LENGTH)}.`;
    expect(long.length).toBeGreaterThan(LLM_TEMPLATE_MAX_LENGTH);
    expectRejection({ ...validCandidate(), template: long }, /template length/);
  });

  it('rejects templates matching every banned volatile pattern', () => {
    const volatileTemplates = [
      'The population of France is ___ million people.',
      'The price of one troy ounce of gold is ___ dollars.',
      'The current world record for the marathon is ___ hours.',
      'The latest version of the standard defines ___ codepoints.',
      'The tallest building today measures ___ meters in height.',
      'The number of UN member states this year is ___ countries.',
      'As of the last census, the city counted ___ residents.',
      'The record high temperature in Death Valley is ___ degrees.',
      'The newest element on the periodic table has ___ protons.',
      'The stock of company X trades at ___ dollars per share.',
      'The market cap of the largest company is ___ trillion.',
    ];
    for (const template of volatileTemplates) {
      expectRejection({ ...validCandidate(), template }, /banned volatile pattern/);
    }
  });

  it('banned pattern matching is case-insensitive', () => {
    expectRejection(
      { ...validCandidate(), template: 'The POPULATION of Mars is ___ humans right now.' },
      /banned volatile pattern/,
    );
    expectRejection(
      { ...validCandidate(), template: 'The LATEST census counted ___ million inhabitants.' },
      /banned volatile pattern/,
    );
  });

  it('word boundaries prevent false positives inside larger words', () => {
    // "Stockholm" must not trip /\bstocks?\b/.
    const result = validateCandidateProbe({
      ...validCandidate(),
      template: 'The latitude of Stockholm is ___ degrees north.',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects non-finite or non-number consensus', () => {
    expectRejection({ ...validCandidate(), consensus: Number.NaN }, /consensus must be a finite number/);
    expectRejection({ ...validCandidate(), consensus: Infinity }, /consensus must be a finite number/);
    expectRejection({ ...validCandidate(), consensus: '3422' }, /consensus must be a finite number/);
    const { consensus: _c, ...noConsensus } = validCandidate();
    expectRejection(noConsensus, /consensus must be a finite number/);
  });

  it('rejects malformed range', () => {
    expectRejection({ ...validCandidate(), range: 'wide' }, /range must be a \[lo, hi\] pair/);
    expectRejection({ ...validCandidate(), range: [3000] }, /range must be a \[lo, hi\] pair/);
    expectRejection({ ...validCandidate(), range: [1, 2, 3] }, /range must be a \[lo, hi\] pair/);
    expectRejection({ ...validCandidate(), range: [Number.NaN, 4000] }, /range bounds must be finite/);
    expectRejection({ ...validCandidate(), range: [3000, Infinity] }, /range bounds must be finite/);
    expectRejection({ ...validCandidate(), range: ['3000', 4000] }, /range bounds must be finite/);
  });

  it('rejects lo >= hi', () => {
    expectRejection({ ...validCandidate(), range: [4000, 3000] }, /strictly less than/);
    expectRejection({ ...validCandidate(), range: [3422, 3422] }, /strictly less than/);
  });

  it('rejects consensus outside the range', () => {
    expectRejection(
      { ...validCandidate(), consensus: 5000 },
      /consensus must lie within range/,
    );
    expectRejection(
      { ...validCandidate(), consensus: 100 },
      /consensus must lie within range/,
    );
  });

  it('rejects malformed tolerance', () => {
    const { tolerance: _t, ...noTolerance } = validCandidate();
    expectRejection(noTolerance, /tolerance must be an object/);
    expectRejection({ ...validCandidate(), tolerance: 'loose' }, /tolerance must be an object/);
    expectRejection({ ...validCandidate(), tolerance: [30] }, /tolerance must be an object/);
    expectRejection(
      { ...validCandidate(), tolerance: { mode: 'fuzzy', value: 30 } },
      /tolerance\.mode/,
    );
    expectRejection(
      { ...validCandidate(), tolerance: { value: 30 } },
      /tolerance\.mode/,
    );
    expectRejection(
      { ...validCandidate(), tolerance: { mode: 'absolute', value: -1 } },
      /tolerance\.value must be a finite number >= 0/,
    );
    expectRejection(
      { ...validCandidate(), tolerance: { mode: 'absolute', value: Number.NaN } },
      /tolerance\.value must be a finite number >= 0/,
    );
    expectRejection(
      { ...validCandidate(), tolerance: { mode: 'absolute' } },
      /tolerance\.value must be a finite number >= 0/,
    );
    expectRejection(
      { ...validCandidate(), tolerance: { mode: 'relative', value: 1.5 } },
      /relative tolerance\.value must be <= 1/,
    );
  });

  it('drops untrusted extra fields, including an LLM-supplied id', () => {
    const candidate = {
      ...validCandidate(),
      id: 'evil:injected:id',
      contrast: { model: 'x' },
      note: 'ignore me',
    };
    const result = validateCandidateProbe(candidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.id).toMatch(/^llm:chemistry-mp:[0-9a-f]{12}$/);
    expect(result.probe).not.toHaveProperty('note');
    expect(result.probe).not.toHaveProperty('contrast');
    expect(Object.keys(result.probe).sort()).toEqual([
      'consensus',
      'domain',
      'id',
      'name',
      'range',
      'template',
      'tolerance',
    ]);
  });
});

describe('computeLlmProbeId', () => {
  it('is deterministic and matches the documented derivation', () => {
    const domain = 'Chemistry MP';
    const template = 'The melting point of tungsten is ___ degrees Celsius.';
    const expected = `llm:chemistry-mp:${sha256Hex(canonicalJsonStringify(template)).slice(0, 12)}`;
    expect(computeLlmProbeId(domain, template)).toBe(expected);
    expect(computeLlmProbeId(domain, template)).toBe(computeLlmProbeId(domain, template));
  });

  it('changes when template or domain changes', () => {
    const template = 'The melting point of tungsten is ___ degrees Celsius.';
    const base = computeLlmProbeId('chemistry', template);
    expect(computeLlmProbeId('chemistry', `${template} `)).not.toBe(base);
    expect(computeLlmProbeId('physics', template)).not.toBe(base);
  });

  it('slugifies messy domains', () => {
    expect(computeLlmProbeId('  Astro / Physics!! ', 'x is ___')).toMatch(/^llm:astro-physics:/);
  });

  it('two validated candidates with the same content share an id', () => {
    const a = validateCandidateProbe(validCandidate());
    const b = validateCandidateProbe(validCandidate());
    expect(a.ok && b.ok && a.probe.id === b.probe.id).toBe(true);
  });
});

describe('BANNED_VOLATILE_PATTERNS', () => {
  it('is a non-empty list of case-insensitive regexes', () => {
    expect(BANNED_VOLATILE_PATTERNS.length).toBeGreaterThanOrEqual(11);
    for (const pattern of BANNED_VOLATILE_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.flags).toContain('i');
      expect(pattern.flags).not.toContain('g'); // no lastIndex statefulness
    }
  });
});

describe('validateCandidateProbes', () => {
  it('splits an array into validated probes and indexed rejections', () => {
    const good = validCandidate();
    const other = {
      ...validCandidate(),
      template: 'The elevation of K2 above sea level is ___ meters.',
    };
    const raw = [
      good,
      { ...validCandidate(), consensus: Number.NaN }, // index 1: bad consensus
      other,
      'not an object', // index 3: not an object
    ];
    const { probes, rejected } = validateCandidateProbes(raw);
    expect(probes).toHaveLength(2);
    expect(probes[0]!.template).toBe(good['template']);
    expect(probes[1]!.template).toBe(other.template);
    expect(rejected).toEqual([
      { index: 1, reason: expect.stringMatching(/consensus/) },
      { index: 3, reason: expect.stringMatching(/plain object/) },
    ]);
  });

  it('rejects duplicate content (same generated id) within a batch', () => {
    const { probes, rejected } = validateCandidateProbes([validCandidate(), validCandidate()]);
    expect(probes).toHaveLength(1);
    expect(rejected).toEqual([{ index: 1, reason: expect.stringMatching(/duplicate probe id/) }]);
  });

  it('rejects a non-array payload as index -1', () => {
    for (const payload of [null, undefined, 'json', 42, validCandidate()]) {
      const { probes, rejected } = validateCandidateProbes(payload);
      expect(probes).toEqual([]);
      expect(rejected).toEqual([{ index: -1, reason: expect.stringMatching(/JSON array/) }]);
    }
  });

  it('returns empty results for an empty array', () => {
    expect(validateCandidateProbes([])).toEqual({ probes: [], rejected: [] });
  });
});
