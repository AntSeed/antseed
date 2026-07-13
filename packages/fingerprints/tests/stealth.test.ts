import { describe, expect, it } from 'vitest';
import {
  buildStealthChatRequests,
  extractAnswersFreeText,
  renderStealthQuestion,
} from '../src/verifiers/kbf/stealth.js';
import { computeMatchVector } from '../src/verifiers/kbf/scoring.js';
import { computeCohortVerdicts } from '../src/cohort.js';
import { generateProbeSet, PROBE_BANK_DOMAINS } from '../src/probe-bank.js';
import type { KbfProbe, ProbeSet, SellerObservation } from '../src/types.js';

const AT = '2026-07-03T00:00:00.000Z';

function probeSet(seed: string, count = 24): ProbeSet {
  return generateProbeSet({ service: 'kimi-k2', count, seed, createdAt: AT });
}

/** A natural "answer" response: restate the cloze with the value in place. */
function synthResponse(probes: readonly KbfProbe[]): string {
  return probes
    .map((p) => {
      const rendered = p.template.includes('{name}')
        ? p.template.split('{name}').join(p.name)
        : p.template;
      return rendered.replace('___', String(p.consensus));
    })
    .join('\n');
}

function P(
  id: string,
  name: string,
  template: string,
  consensus: number,
  range: [number, number],
  value = Math.max(Math.abs(consensus) * 0.01, 1),
): KbfProbe {
  return { id, name, domain: 'test', template, consensus, range, tolerance: { mode: 'absolute', value } };
}

const TANTALUM = P(
  'chemistry_mp:tantalum-carbide',
  'tantalum carbide',
  'The melting point of tantalum carbide is ___°C.',
  3880,
  [-300, 4500],
  60,
);
const HUMAN = P(
  'biology_2n:human',
  'human',
  'The diploid chromosome number (2n) of humans is ___.',
  46,
  [2, 500],
  0.5,
);
const MARS = P(
  'astronomy:mars-orbital-days',
  'Mars',
  'The orbital period of Mars is ___ Earth days.',
  687,
  [0, 100000],
  3,
);
const LIGHT = P(
  'physics_const:speed-of-light-kms',
  'speed of light',
  'The speed of light in vacuum is ___ km/s.',
  299792.458,
  [0, 500000],
  2,
);
const TUNGSTEN_MP = P(
  'comp:element_mp:tungsten',
  'tungsten',
  'The melting point of tungsten is ___°C.',
  3422,
  [-260, 4000],
  40,
);
const TUNGSTEN_BP = P(
  'comp:element_bp:tungsten',
  'tungsten',
  'The boiling point of tungsten is ___°C.',
  5555,
  [-270, 6000],
  60,
);
const TUNGSTEN_Z = P(
  'comp:element_z:tungsten',
  'tungsten',
  'The atomic number of tungsten is ___.',
  74,
  [1, 120],
  0.5,
);

describe('buildStealthChatRequests — determinism', () => {
  it('same probe set → byte-identical plans', () => {
    const ps = probeSet('determinism');
    const a = buildStealthChatRequests('kimi-k2', ps);
    const b = buildStealthChatRequests('kimi-k2', ps);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a different nonce → different framings/partitioning', () => {
    const a = buildStealthChatRequests('kimi-k2', probeSet('nonce-a'));
    const b = buildStealthChatRequests('kimi-k2', probeSet('nonce-b'));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('threads the model through to every request body', () => {
    const plans = buildStealthChatRequests('some-model-v3', probeSet('model'));
    for (const plan of plans) {
      expect(plan.body.model).toBe('some-model-v3');
    }
  });
});

describe('buildStealthChatRequests — seed derivation', () => {
  it('probe-id lists that join to the same string still derive distinct streams', () => {
    // With a naive `${nonce}|${ids.join(',')}` seed these two sets collide:
    // ['a,b','c',...] and ['a','b,c',...] both join to "a,b,c,...".
    const contents = Array.from({ length: 8 }, (_, i) =>
      P(`placeholder-${i}`, `quantity ${i}`, `The value of quantity ${i} is ___.`, 100 + i, [0, 1000]),
    );
    const withIds = (ids: readonly string[]): ProbeSet => ({
      probeSetId: 'test',
      service: 'kimi-k2',
      probes: contents.map((p, i) => ({ ...p, id: ids[i]! })),
      nonce: 'fixed-nonce',
      createdAt: AT,
    });
    const idsA = ['a,b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const idsB = ['a', 'b,c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(idsA.join(',')).toBe(idsB.join(','));

    const bodiesA = buildStealthChatRequests('kimi-k2', withIds(idsA)).map((p) => p.body);
    const bodiesB = buildStealthChatRequests('kimi-k2', withIds(idsB)).map((p) => p.body);
    expect(JSON.stringify(bodiesA)).not.toBe(JSON.stringify(bodiesB));
  });
});

describe('buildStealthChatRequests — partitioning & coverage', () => {
  it('covers every probe exactly once, in set order', () => {
    const ps = probeSet('coverage', 30);
    const plans = buildStealthChatRequests('kimi-k2', ps, { maxProbesPerRequest: 3 });
    const covered = plans.flatMap((p) => p.probeIndices);
    expect(covered).toEqual([...Array(ps.probes.length).keys()]);
    // probes array matches the indices
    for (const plan of plans) {
      expect(plan.probes).toEqual(plan.probeIndices.map((i) => ps.probes[i]));
    }
  });

  it('respects maxProbesPerRequest bounds (default 3, and clamps min to 1)', () => {
    const ps = probeSet('bounds', 30);
    for (const max of [1, 2, 3, 5]) {
      const plans = buildStealthChatRequests('kimi-k2', ps, { maxProbesPerRequest: max });
      for (const plan of plans) {
        expect(plan.probes.length).toBeGreaterThanOrEqual(1);
        expect(plan.probes.length).toBeLessThanOrEqual(max);
      }
    }
    // A degenerate max (0 or negative) is clamped to 1.
    const single = buildStealthChatRequests('kimi-k2', ps, { maxProbesPerRequest: 0 });
    for (const plan of single) {
      expect(plan.probes.length).toBe(1);
    }
  });
});

describe('buildStealthChatRequests — same-entity separation', () => {
  // Two probes about the same entity ("melting point of tungsten" + "boiling
  // point of tungsten") in one message elicit a combined answer like "The
  // melting point of tungsten is 3422°C, and its boiling point is 5555°C.",
  // where the shared entity anchor makes the extractor grab the same number
  // for both probes. The partitioner must never bundle them.
  const withNonce = (nonce: string): ProbeSet => ({
    probeSetId: 'test',
    service: 'kimi-k2',
    probes: [TUNGSTEN_MP, TUNGSTEN_BP, TUNGSTEN_Z, HUMAN, MARS, LIGHT, TANTALUM],
    nonce,
    createdAt: AT,
  });

  it('never places two probes sharing an entity name in the same request', () => {
    for (const nonce of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']) {
      const ps = withNonce(nonce);
      const plans = buildStealthChatRequests('kimi-k2', ps, { maxProbesPerRequest: 3 });
      for (const plan of plans) {
        const names = plan.probes.map((p) => p.name.toLowerCase());
        expect(new Set(names).size, `nonce ${nonce}`).toBe(names.length);
      }
      // Splitting must not break coverage: every probe exactly once, in order.
      const covered = plans.flatMap((p) => p.probeIndices);
      expect(covered).toEqual([...Array(ps.probes.length).keys()]);
    }
  });
});

describe('buildStealthChatRequests — stealth invariants', () => {
  it('50+ requests contain no probe-signature strings', () => {
    const forbidden = ['(1)', 'TASK', 'RULES', 'ONLY in', 'format'];
    let requestCount = 0;
    let withSystem = 0;
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const plans = buildStealthChatRequests('kimi-k2', probeSet(seed, 60), {
        maxProbesPerRequest: 3,
      });
      for (const plan of plans) {
        requestCount++;
        const serialized = JSON.stringify(plan.body.messages);
        for (const needle of forbidden) {
          expect(serialized).not.toContain(needle);
        }
        // temperature and max_tokens are omitted (organic clients set neither).
        expect(plan.body).not.toHaveProperty('temperature');
        expect(plan.body.max_tokens).toBeUndefined();
        const roles = plan.body.messages.map((m) => m.role);
        expect(roles[roles.length - 1]).toBe('user');
        if (roles[0] === 'system') withSystem++;
      }
    }
    expect(requestCount).toBeGreaterThanOrEqual(50);
    // Most requests carry no system message; only a minority do.
    expect(withSystem).toBeGreaterThan(0);
    expect(withSystem).toBeLessThan(requestCount / 2);
  });
});

describe('cloze → natural question transformer', () => {
  it('renders every bank domain without "___" or the raw template', () => {
    const ps = probeSet('transform', 70);
    for (const domain of PROBE_BANK_DOMAINS) {
      const sample = ps.probes.find((p) => p.domain === domain);
      expect(sample, `sample for ${domain}`).toBeDefined();
      const q = renderStealthQuestion(sample!);
      expect(q).not.toContain('___');
      expect(q).not.toContain(sample!.template);
      expect(q.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic given a seed', () => {
    expect(renderStealthQuestion(TANTALUM, 'x')).toBe(renderStealthQuestion(TANTALUM, 'x'));
    expect(renderStealthQuestion(TANTALUM, 'x')).not.toBe(renderStealthQuestion(TANTALUM, 'y'));
  });
});

describe('extractAnswersFreeText', () => {
  it('extracts a number from a prose sentence', () => {
    expect(
      extractAnswersFreeText('The melting point of tantalum carbide is about 3,880°C.', [TANTALUM]),
    ).toEqual([3880]);
  });

  it('handles ≈ and unit suffixes', () => {
    expect(extractAnswersFreeText('The speed of light is ≈ 299,792.458 km/s.', [LIGHT])).toEqual([
      299792.458,
    ]);
  });

  it('reads markdown lists in any order', () => {
    const md = '- Mars orbital period: **687** days\n- Humans: 46 chromosomes';
    expect(extractAnswersFreeText(md, [HUMAN, MARS])).toEqual([46, 687]);
  });

  it('handles bold markdown around the number', () => {
    expect(
      extractAnswersFreeText('The melting point of tantalum carbide is **3880°C**.', [TANTALUM]),
    ).toEqual([3880]);
  });

  it('mixes correct and missing answers (prefers null over a wrong grab)', () => {
    const text = 'I know tantalum carbide melts at 3880°C. I forget the Mars figure though.';
    expect(extractAnswersFreeText(text, [TANTALUM, MARS])).toEqual([3880, null]);
  });

  it('vetoes wildly out-of-range candidates via probe.range', () => {
    const text = 'Someone claimed tantalum carbide melts at 9999999 degrees, which is nonsense.';
    expect(extractAnswersFreeText(text, [TANTALUM])).toEqual([null]);
  });

  it('extracts several probes from one multi-sentence response', () => {
    const text =
      'The melting point of tantalum carbide is 3880°C. ' +
      'Humans have 46 chromosomes. Mars orbits in 687 days.';
    expect(extractAnswersFreeText(text, [TANTALUM, HUMAN, MARS])).toEqual([3880, 46, 687]);
  });

  it('falls back to answer-order alignment when nothing is named', () => {
    expect(extractAnswersFreeText('Sure! 3880, then 46.', [TANTALUM, HUMAN])).toEqual([3880, 46]);
  });

  it('returns all null and never throws on junk input', () => {
    expect(extractAnswersFreeText('no numbers here at all', [TANTALUM])).toEqual([null]);
    expect(extractAnswersFreeText('', [TANTALUM])).toEqual([null]);
    // @ts-expect-error — defensive: must not throw on a non-string input
    expect(extractAnswersFreeText(null, [TANTALUM])).toEqual([null]);
    expect(extractAnswersFreeText('42', [])).toEqual([]);
  });
});

describe('extractAnswersFreeText — adversarial phrasings', () => {
  const JUPITER = P(
    'astronomy:jupiter-orbital-years',
    'Jupiter',
    'The orbital period of Jupiter is ___ Earth years.',
    11.86,
    [0, 1000],
    0.15,
  );

  it('does not split sentences on decimal points; finds a candidate before its anchor', () => {
    expect(extractAnswersFreeText("11.86 years is Jupiter's orbital period.", [JUPITER])).toEqual([
      11.86,
    ]);
  });

  it('strips markdown list ordinals from the positional fallback', () => {
    expect(extractAnswersFreeText('1. 3880\n2. 46', [TANTALUM, HUMAN])).toEqual([3880, 46]);
  });

  it('ignores preamble count words in the positional fallback', () => {
    expect(
      extractAnswersFreeText('Sure, here are 2 quick answers: 3880 and 46.', [TANTALUM, HUMAN]),
    ).toEqual([3880, 46]);
  });

  it('breaks window-score ties toward the LAST window (answers follow preambles)', () => {
    // The preamble "2" is in-range for the 2n probe ([2, 500]), so the windows
    // [2, 46] and [46, 3880] tie on score. Earliest-window tie-breaking used
    // to return [2, 46] — both wrong, both in range, so both scored as hard
    // mismatches.
    expect(
      extractAnswersFreeText('Sure, here are 2 quick answers: 46 and 3880.', [HUMAN, TANTALUM]),
    ).toEqual([46, 3880]);
  });

  it('tie-break holds for longer probe lists with an in-range preamble numeral', () => {
    // "3" is in-range for the 2n probe, so [3, 46, 687] ties [46, 687, 3880].
    expect(
      extractAnswersFreeText('I have 3 answers for you: 46, 687, and 3880.', [
        HUMAN,
        MARS,
        TANTALUM,
      ]),
    ).toEqual([46, 687, 3880]);
  });

  it('anchors property verb forms: "melts"/"boils" sentences resolve per property', () => {
    const text = 'Tungsten melts at 3422°C. It boils at around 5555°C.';
    expect(extractAnswersFreeText(text, [TUNGSTEN_MP, TUNGSTEN_BP])).toEqual([3422, 5555]);
    // Probe order must not matter — extraction is per-probe.
    expect(extractAnswersFreeText(text, [TUNGSTEN_BP, TUNGSTEN_MP])).toEqual([5555, 3422]);
  });

  it('a single-property request stays correct when the response volunteers both properties', () => {
    // With same-entity probes split into separate requests (see the
    // partitioning tests), each response is extracted against ONE tungsten
    // probe — the "melting" anchor keeps the grab on the right clause.
    const text = 'The melting point of tungsten is 3422°C, and its boiling point is 5555°C.';
    expect(extractAnswersFreeText(text, [TUNGSTEN_MP])).toEqual([3422]);
  });

  it('a predicate-attached number beats a nearer incidental in-range numeral', () => {
    expect(
      extractAnswersFreeText(
        'As measured in 2020, tantalum carbide has a melting point of 3880°C.',
        [TANTALUM],
      ),
    ).toEqual([3880]);
  });

  it('normalizes the Unicode minus (U+2212) instead of silently dropping the sign', () => {
    const DEAD_SEA = P(
      'geography:dead-sea-m',
      'Dead Sea',
      'The surface elevation of the Dead Sea is ___ meters.',
      -430,
      [-12000, 10000],
      15,
    );
    expect(
      extractAnswersFreeText('The surface elevation of the Dead Sea is −430 meters.', [
        DEAD_SEA,
      ]),
    ).toEqual([-430]);

    const ABSOLUTE_ZERO = P(
      'physics_const:absolute-zero-c',
      'absolute zero',
      'Absolute zero is ___°C.',
      -273.15,
      [-500, 0],
      0.01,
    );
    expect(extractAnswersFreeText('Absolute zero is −273.15°C.', [ABSOLUTE_ZERO])).toEqual([
      -273.15,
    ]);
  });

  it('reads leading-decimal forms (".5") at full value, never as a bare mantissa', () => {
    const LN2 = P(
      'math_const:ln2-6dp',
      'natural log of 2',
      'The natural logarithm of 2 rounded to 6 decimal places is ___.',
      0.693147,
      [0, 1],
      0.01,
    );
    // Old scanner matched only the "69" of ".69" — a silent 100x magnitude change.
    expect(extractAnswersFreeText('The natural logarithm of 2 is about .69', [LN2])).toEqual([
      0.69,
    ]);
  });
});

describe('extractAnswersFreeText — question-echo suppression', () => {
  const SQRT3 = P(
    'math_const:sqrt3-6dp',
    'square root of 3',
    'The square root of 3 rounded to 6 decimal places is ___.',
    1.732051,
    [0, 10],
    0.000002,
  );

  it('a number echoed from the question loses to the uncued true answer', () => {
    // The echoed 3 carries a weak "of" cue while 1.732051 has no cue at all —
    // without echo suppression the subject 3 wins (in range, stronger cue).
    expect(
      extractAnswersFreeText('For the square root of 3 you get 1.732051 as the value.', [SQRT3]),
    ).toEqual([1.732051]);
  });

  it('still prefers the strongly-cued true answer when the echo sits closer', () => {
    expect(
      extractAnswersFreeText('The square root of 3 is 1.732051.', [SQRT3]),
    ).toEqual([1.732051]);
  });

  it('a legitimate echo answer still extracts when nothing else is in range', () => {
    // Deprioritize, never exclude: when the true answer coincides with a
    // number in the question and is the only in-range candidate, it must win.
    const ECHO = P(
      'test:echo-answer',
      'x where x equals 3',
      'The value of x where x equals 3 is ___.',
      3,
      [0, 10],
      0.5,
    );
    expect(extractAnswersFreeText('the answer is 3', [ECHO])).toEqual([3]);
  });
});

describe('round-trip: build → synth prose response → extract → score', () => {
  it('yields all-1 match vectors across seeds and request sizes', () => {
    for (const seed of ['rt-a', 'rt-b', 'rt-c', 'rt-d']) {
      for (const maxProbesPerRequest of [1, 2, 3]) {
        const ps = probeSet(seed, 40);
        const plans = buildStealthChatRequests('kimi-k2', ps, { maxProbesPerRequest });
        const answers = new Array<number | null>(ps.probes.length).fill(null);
        for (const plan of plans) {
          const extracted = extractAnswersFreeText(synthResponse(plan.probes), plan.probes);
          plan.probeIndices.forEach((globalIndex, k) => {
            answers[globalIndex] = extracted[k]!;
          });
        }
        const mv = computeMatchVector(answers, ps.probes);
        expect(mv.every((entry) => entry === 1), `${seed} / max ${maxProbesPerRequest}`).toBe(true);
      }
    }
  });
});

describe('end-to-end cohort verification via the stealth pipeline', () => {
  it('flags the liar DIFF while honest sellers are SAME', () => {
    const ps = probeSet('cohort-e2e', 30);
    const plans = buildStealthChatRequests('kimi-k2', ps);

    const answersFor = (transform: (p: KbfProbe) => number): Array<number | null> => {
      const answers = new Array<number | null>(ps.probes.length).fill(null);
      for (const plan of plans) {
        const shifted = plan.probes.map((p) => ({ ...p, consensus: transform(p) }));
        const extracted = extractAnswersFreeText(synthResponse(shifted), plan.probes);
        plan.probeIndices.forEach((globalIndex, k) => {
          answers[globalIndex] = extracted[k]!;
        });
      }
      return answers;
    };

    const observations: SellerObservation[] = [];
    for (let s = 0; s < 6; s++) {
      observations.push({
        sellerPeerId: `0xhonest${s}`,
        agentId: s + 1,
        answers: answersFor((p) => p.consensus),
        requestIds: [`req-${s}`],
      });
    }
    // The substitute model answers a consistently different value everywhere.
    observations.push({
      sellerPeerId: '0xliar',
      agentId: 99,
      answers: answersFor((p) => p.consensus * 1.4 + 7),
      requestIds: ['req-liar'],
    });

    const result = computeCohortVerdicts(observations, ps.probes);
    const liar = result.verdicts.find((v) => v.sellerPeerId === '0xliar')!;
    expect(liar.verdict).toBe('DIFF');
    for (const v of result.verdicts.filter((x) => x.sellerPeerId !== '0xliar')) {
      expect(v.verdict).toBe('SAME');
      expect(v.stats.agreementRate).toBe(1);
    }
  });
});
