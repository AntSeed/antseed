import { describe, expect, it } from 'vitest';
import { createVerifierRegistry } from '../src/registry.js';
import {
  buildKbfChatRequestBody,
  buildKbfPrompt,
  KbfVerifier,
  parseKbfAnswers,
} from '../src/verifiers/kbf/index.js';
import { canonicalHash } from '../src/canonical-json.js';
import { generateProbeSet } from '../src/probe-bank.js';
import type { FingerprintReference, SellerObservation } from '../src/types.js';

const PROBES = generateProbeSet({
  service: 'gpt-5.4',
  count: 20,
  seed: 'kbf-verifier-test',
  createdAt: '2026-07-03T00:00:00.000Z',
}).probes;

function makeReference(overrides: Partial<FingerprintReference> = {}): FingerprintReference {
  const outcomes = PROBES.map((probe) => ({
    probeId: probe.id,
    answer: probe.consensus,
    match: 1 as const,
  }));
  return {
    version: 1,
    kind: 'kbf',
    referenceId: 'sha256:test-reference',
    referenceModel: 'openai/gpt-5.4',
    serviceAliases: ['gpt-5.4'],
    createdAt: '2026-06-14T00:00:00.000Z',
    source: 'generated',
    generator: {
      name: '@antseed/fingerprints',
      version: '0.1.0',
      verifierKind: 'kbf',
      params: {},
    },
    selfTest: { hamming: 0, total: PROBES.length, coverage: 1, errorRate: 0, outcomes },
    probes: PROBES,
    ...overrides,
  };
}

function makeObservation(answers: Array<number | null>): SellerObservation {
  return {
    sellerPeerId: '0xseller',
    agentId: 7,
    answers,
    requestIds: ['req-1'],
  };
}

describe('buildKbfPrompt', () => {
  it('emits the TASK/RULES header and numbered cloze lines', () => {
    const prompt = buildKbfPrompt(PROBES.slice(0, 3));
    expect(prompt).toMatch(/^TASK: /);
    expect(prompt).toContain('RULES: Output ONLY in (N) <number> format');
    expect(prompt).toContain('(1) ');
    expect(prompt).toContain('(2) ');
    expect(prompt).toContain('(3) ');
    expect(prompt).toContain('___');
    expect(prompt).not.toContain('{name}');
  });

  it('applies the batch index offset', () => {
    const prompt = buildKbfPrompt(PROBES.slice(0, 2), 10);
    expect(prompt).toContain('(11) ');
    expect(prompt).toContain('(12) ');
    expect(prompt).not.toContain('(1) ');
  });
});

describe('buildKbfChatRequestBody', () => {
  it('builds an OpenAI-compatible chat.completions body', () => {
    const body = buildKbfChatRequestBody('gpt-5.4', PROBES.slice(0, 10));
    expect(body.model).toBe('gpt-5.4');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[1]!.role).toBe('user');
    expect(body.messages[1]!.content).toContain('TASK:');
    expect(JSON.parse(JSON.stringify(body))).toEqual(body); // plain JSON
  });
});

describe('KbfVerifier', () => {
  const verifier = new KbfVerifier();

  it('round-trips: prompt -> simulated response -> parse -> SAME', () => {
    const reference = makeReference();
    const responseText = PROBES.map((p, i) => `(${i + 1}) ${p.consensus}`).join('\n');
    const answers = parseKbfAnswers(responseText, PROBES.length);
    const fragment = verifier.verify(reference, makeObservation(answers));
    expect(fragment.verdict).toBe('SAME');
    expect(fragment.parsedProbeCount).toBe(PROBES.length);
    expect(fragment.stats.targetHamming).toBe(0);
    expect(fragment.matchVectorHash).toBe(canonicalHash(fragment.matchVector));
  });

  it('flags a substitute answering differently as DIFF', () => {
    const reference = makeReference();
    // Answer far outside tolerance but inside range for every probe.
    const answers = PROBES.map((p) => {
      const [lo, hi] = p.range;
      const wrong = p.consensus + Math.max((hi - lo) * 0.2, p.tolerance.value * 50 + 1);
      return Math.min(wrong, hi);
    });
    const fragment = verifier.verify(reference, makeObservation(answers));
    expect(fragment.verdict).toBe('DIFF');
    expect(fragment.stats.pValueBinomial!).toBeLessThan(0.05);
  });

  it('returns UNDETERMINED below coverage', () => {
    const reference = makeReference();
    const answers = PROBES.map((p, i) => (i < 5 ? p.consensus : null));
    const fragment = verifier.verify(reference, makeObservation(answers));
    expect(fragment.verdict).toBe('UNDETERMINED');
  });

  it('returns UNKNOWN for a non-kbf reference', () => {
    const reference = makeReference({ kind: 'behavioral-classifier' });
    const fragment = verifier.verify(reference, makeObservation(PROBES.map((p) => p.consensus)));
    expect(fragment.verdict).toBe('UNKNOWN');
    expect(fragment.verdictReason).toMatch(/kind/);
  });

  it('returns UNKNOWN for an invalid self-test', () => {
    const reference = makeReference({
      selfTest: { hamming: 0, total: 0, coverage: 0, errorRate: 0, outcomes: [] },
    });
    const fragment = verifier.verify(reference, makeObservation(PROBES.map((p) => p.consensus)));
    expect(fragment.verdict).toBe('UNKNOWN');
  });

  it('returns UNKNOWN on answer-count mismatch', () => {
    const reference = makeReference();
    const fragment = verifier.verify(reference, makeObservation([1, 2, 3]));
    expect(fragment.verdict).toBe('UNKNOWN');
    expect(fragment.verdictReason).toMatch(/length/);
  });

  it('uses a precomputed matchVector when provided', () => {
    const reference = makeReference();
    const observation: SellerObservation = {
      ...makeObservation([]),
      matchVector: PROBES.map(() => 1 as const),
    };
    const fragment = verifier.verify(reference, observation);
    expect(fragment.verdict).toBe('SAME');
    expect(fragment.stats.targetHamming).toBe(0);
  });

  it('returns UNKNOWN when a supplied matchVector holds entries other than 0/1/null', () => {
    const reference = makeReference();
    const invalidVectors = [
      PROBES.map((_, i) => (i === 0 ? 2 : 1)), // 2 is not a match
      PROBES.map((_, i) => (i === 0 ? true : 1)), // truthy boolean
      PROBES.map((_, i) => (i === 0 ? '1' : 1)), // string digit
      PROBES.map((_, i) => (i === 0 ? undefined : 1)), // hole
    ];
    for (const matchVector of invalidVectors) {
      const observation = {
        ...makeObservation([]),
        matchVector,
      } as unknown as SellerObservation;
      const fragment = verifier.verify(reference, observation);
      expect(fragment.verdict).toBe('UNKNOWN');
      expect(fragment.verdictReason).toMatch(/exactly 0, 1, or null/);
    }
  });
});

describe('createVerifierRegistry', () => {
  it('pre-registers the kbf verifier', () => {
    const registry = createVerifierRegistry();
    expect(registry.list()).toContain('kbf');
    expect(registry.get('kbf')).toBeInstanceOf(KbfVerifier);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('registers and dispatches custom verifiers by kind', () => {
    const registry = createVerifierRegistry();
    const fake = {
      kind: 'behavioral-classifier',
      verify: () => {
        throw new Error('not implemented');
      },
    };
    registry.register(fake);
    expect(registry.get('behavioral-classifier')).toBe(fake);
    expect(registry.list().sort()).toEqual(['behavioral-classifier', 'kbf']);
  });
});
