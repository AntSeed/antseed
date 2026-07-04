import { describe, expect, it } from 'vitest';
import {
  deterministicSample,
  staticProbeSource,
  type ProbeSource,
} from '../src/probe-source.js';
import { compositionalProbeSource, COMPOSITIONAL_SOURCE_ID } from '../src/compositional/source.js';
import { probeBankSource, generateProbeSet, PROBE_BANK } from '../src/probe-bank.js';
import { buildStealthChatRequests, extractAnswersFreeText } from '../src/verifiers/kbf/stealth.js';
import { computeCohortVerdicts } from '../src/cohort.js';
import { computeProbeCommitment } from '../src/types.js';
import type { KbfProbe, SellerObservation } from '../src/types.js';

const AT = '2026-07-04T00:00:00.000Z';

/** A natural "answer" response: restate each cloze with the value in place. */
function synthResponse(probes: readonly KbfProbe[], value: (p: KbfProbe) => number): string {
  return probes
    .map((p) => {
      const rendered = p.template.includes('{name}')
        ? p.template.split('{name}').join(p.name)
        : p.template;
      return rendered.replace('___', String(value(p)));
    })
    .join('\n');
}

function fakeProbe(id: string): KbfProbe {
  return {
    id,
    name: id,
    domain: 'test',
    template: `The value of ${id} is ___.`,
    consensus: 1,
    range: [0, 100],
    tolerance: { mode: 'absolute', value: 1 },
  };
}

const POOL = Array.from({ length: 50 }, (_, i) => fakeProbe(`p${i}`));

describe('deterministicSample', () => {
  it('same seed → identical selection and order', () => {
    const a = deterministicSample(POOL, { count: 10, seed: 'x' });
    const b = deterministicSample(POOL, { count: 10, seed: 'x' });
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
  });

  it('different seeds → different selection', () => {
    const a = deterministicSample(POOL, { count: 10, seed: 'x' });
    const b = deterministicSample(POOL, { count: 10, seed: 'y' });
    expect(a.map((p) => p.id)).not.toEqual(b.map((p) => p.id));
  });

  it('never returns an excluded id', () => {
    const exclude = new Set(POOL.slice(0, 40).map((p) => p.id));
    const picked = deterministicSample(POOL, { count: 10, seed: 'x', exclude });
    expect(picked).toHaveLength(10);
    for (const p of picked) expect(exclude.has(p.id)).toBe(false);
  });

  it('rejects a count larger than the live pool after exclusion', () => {
    const exclude = new Set(POOL.slice(0, 45).map((p) => p.id));
    expect(() => deterministicSample(POOL, { count: 10, seed: 'x', exclude })).toThrow(/exceeds/);
  });

  it('rejects non-positive counts', () => {
    expect(() => deterministicSample(POOL, { count: 0, seed: 'x' })).toThrow();
    expect(() => deterministicSample(POOL, { count: -3, seed: 'x' })).toThrow();
  });
});

describe('staticProbeSource', () => {
  it('reports size and default advisory consensus', () => {
    const src = staticProbeSource('fixture', POOL);
    expect(src.id).toBe('fixture');
    expect(src.size).toBe(POOL.length);
    expect(src.consensusCertified).toBe(false);
  });

  it('can be marked certified (reference mode)', () => {
    const src = staticProbeSource('ref', POOL, { consensusCertified: true });
    expect(src.consensusCertified).toBe(true);
  });
});

describe('probeBankSource', () => {
  it('wraps the built-in bank, advisory consensus', () => {
    const src = probeBankSource();
    expect(src.size).toBe(PROBE_BANK.length);
    expect(src.consensusCertified).toBe(false);
  });
});

describe('compositionalProbeSource', () => {
  const src: ProbeSource = compositionalProbeSource();

  it('is far larger than the static bank and rotatable', () => {
    expect(src.id).toBe(COMPOSITIONAL_SOURCE_ID);
    expect(src.size).toBeGreaterThan(PROBE_BANK.length * 3);
    expect(src.consensusCertified).toBe(false);
  });

  it('produces unique, well-formed probes', () => {
    const probes = src.generate({ count: 40, seed: 's' });
    expect(new Set(probes.map((p) => p.id)).size).toBe(40);
    for (const p of probes) {
      expect(p.id.startsWith('comp:')).toBe(true);
      expect(p.template).toContain('___');
      expect(p.template).not.toContain('{name}');
      expect(p.range[0]).toBeLessThan(p.range[1]);
      expect(p.advisoryConsensus).toBe(true);
    }
  });

  it('honors the rotation exclude set', () => {
    const first = src.generate({ count: 30, seed: 'a' });
    const exclude = new Set(first.map((p) => p.id));
    const second = src.generate({ count: 30, seed: 'a', exclude });
    for (const p of second) expect(exclude.has(p.id)).toBe(false);
  });
});

describe('generateProbeSet with a source', () => {
  it('draws from the provided source and stays commit-stable per seed', () => {
    const src = compositionalProbeSource();
    const a = generateProbeSet({ service: 's', count: 20, seed: 'k', source: src });
    const b = generateProbeSet({ service: 's', count: 20, seed: 'k', source: src });
    expect(computeProbeCommitment(a)).toBe(computeProbeCommitment(b));
    for (const p of a.probes) expect(p.id.startsWith('comp:')).toBe(true);
  });

  it('excluded ids never appear in the generated set', () => {
    const src = compositionalProbeSource();
    const first = generateProbeSet({ service: 's', count: 20, seed: 'k', source: src });
    const exclude = new Set(first.probes.map((p) => p.id));
    const second = generateProbeSet({ service: 's', count: 20, seed: 'k', source: src, exclude });
    for (const p of second.probes) expect(exclude.has(p.id)).toBe(false);
  });

  it('default (no source) still draws from the bank', () => {
    const set = generateProbeSet({ service: 's', count: 12, seed: 'k' });
    const bankIds = new Set(PROBE_BANK.map((p) => p.id));
    for (const p of set.probes) expect(bankIds.has(p.id)).toBe(true);
  });
});

describe('compositional probes end-to-end through the stealth pipeline', () => {
  it('extracts answers and flags the liar DIFF, honest sellers SAME', () => {
    const ps = generateProbeSet({
      service: 'kimi-k2',
      count: 30,
      seed: 'comp-e2e',
      source: compositionalProbeSource(),
      createdAt: AT,
    });
    const plans = buildStealthChatRequests('kimi-k2', ps);

    const answersFor = (value: (p: KbfProbe) => number): Array<number | null> => {
      const answers = new Array<number | null>(ps.probes.length).fill(null);
      for (const plan of plans) {
        const extracted = extractAnswersFreeText(synthResponse(plan.probes, value), plan.probes);
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
    }
  });
});
