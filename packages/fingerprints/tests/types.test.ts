import { describe, expect, it } from 'vitest';
import {
  computeEvidenceHash,
  computeProbeCommitment,
  computeProbeSetId,
  computeReferenceId,
  verdictFromCode,
  verdictToCode,
  type EvidenceBundle,
  type FingerprintReference,
  type FingerprintVerdict,
} from '../src/types.js';
import { generateProbeSet } from '../src/probe-bank.js';
import { computeCohortVerdicts } from '../src/cohort.js';

describe('verdict codes', () => {
  it('uses the frozen on-chain enum mapping', () => {
    expect(verdictToCode('UNKNOWN')).toBe(0);
    expect(verdictToCode('SAME')).toBe(1);
    expect(verdictToCode('DIFF')).toBe(2);
    expect(verdictToCode('UNDETERMINED')).toBe(3);
  });

  it('round-trips all verdicts', () => {
    const verdicts: FingerprintVerdict[] = ['UNKNOWN', 'SAME', 'DIFF', 'UNDETERMINED'];
    for (const verdict of verdicts) {
      expect(verdictFromCode(verdictToCode(verdict))).toBe(verdict);
    }
  });

  it('throws on unknown values', () => {
    expect(() => verdictFromCode(4)).toThrow();
    expect(() => verdictFromCode(-1)).toThrow();
    expect(() => verdictToCode('MAYBE' as FingerprintVerdict)).toThrow();
  });
});

function makeReference(): FingerprintReference {
  return {
    version: 1,
    kind: 'kbf',
    referenceId: 'sha256:placeholder',
    referenceModel: 'openai/gpt-5.4',
    serviceAliases: ['gpt-5.4', 'openai/gpt-5.4'],
    createdAt: '2026-06-14T00:00:00.000Z',
    source: 'generated',
    generator: {
      name: '@antseed/fingerprints',
      version: '0.1.0',
      verifierKind: 'kbf',
      params: {},
    },
    selfTest: { hamming: 3, total: 224, coverage: 1, errorRate: 0.0134 },
    probes: [],
  };
}

describe('computeReferenceId', () => {
  it('excludes referenceId itself so the id is stable', () => {
    const ref = makeReference();
    const id = computeReferenceId(ref);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeReferenceId({ ...ref, referenceId: id })).toBe(id);
  });

  it('excludes declared local-only fields', () => {
    const ref = makeReference();
    const withLocal = { ...ref, localPath: '/tmp/somewhere.json' };
    expect(computeReferenceId(withLocal, ['localPath'])).toBe(computeReferenceId(ref));
    expect(computeReferenceId(withLocal)).not.toBe(computeReferenceId(ref));
  });

  it('preserves unknown extension fields in the hash', () => {
    const ref = makeReference();
    const extended = { ...ref, futureField: { anything: true } };
    expect(computeReferenceId(extended)).not.toBe(computeReferenceId(ref));
  });
});

describe('evidence bundle hashing', () => {
  function makeBundle(): EvidenceBundle {
    const probeSet = generateProbeSet({
      service: 'kimi-k2',
      count: 12,
      seed: 'evidence',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    const observations = ['0xaaa', '0xbbb', '0xccc'].map((sellerPeerId, s) => ({
      sellerPeerId,
      agentId: s + 1,
      answers: probeSet.probes.map((p) => p.consensus),
      requestIds: [`req-${s}`],
      responseAuthHashes: [{ requestHash: `0x0${s}`, responseHash: `0x1${s}` }],
    }));
    const cohort = computeCohortVerdicts(observations, probeSet.probes, {
      minConsensusProbes: 5,
    });
    return {
      version: 1,
      service: 'kimi-k2',
      verifierAddress: '0x1111111111111111111111111111111111111111',
      probeSet,
      sellers: observations.map((o, s) => ({
        ...o,
        verdict: cohort.verdicts[s]!.verdict,
        stats: cohort.verdicts[s]!.stats,
      })),
      cohort,
      createdAt: '2026-07-03T00:00:00.000Z',
    };
  }

  it('is stable across runs (fixed expected hash)', () => {
    const hash = computeEvidenceHash(makeBundle());
    // Pinned over the HKDF/HMAC_DRBG derivation (prng.ts). If this breaks, the
    // wire format changed — bump the HKDF salt version, don't silently re-pin.
    expect(hash).toBe('0xe8796f90435f13b42f8fb693df1f47b3af72ab4e928e7f71c835efbdb2e86827');
    expect(computeEvidenceHash(makeBundle())).toBe(hash);
  });

  it('is independent of object key insertion order', () => {
    const bundle = makeBundle();
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(bundle).reverse()) {
      shuffled[key] = (bundle as unknown as Record<string, unknown>)[key];
    }
    expect(computeEvidenceHash(shuffled as unknown as EvidenceBundle)).toBe(
      computeEvidenceHash(bundle),
    );
  });

  it('changes when any field changes', () => {
    const bundle = makeBundle();
    const base = computeEvidenceHash(bundle);
    expect(computeEvidenceHash({ ...bundle, service: 'other-model' })).not.toBe(base);
    expect(
      computeEvidenceHash({ ...bundle, verifierAddress: '0x2222222222222222222222222222222222222222' }),
    ).not.toBe(base);
  });
});

describe('probe set ids and commitments', () => {
  it('probeSetId depends on probe order', () => {
    const probeSet = generateProbeSet({
      service: 's',
      count: 6,
      seed: 'order',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    const reversedId = computeProbeSetId('s', [...probeSet.probes].reverse());
    expect(reversedId).not.toBe(probeSet.probeSetId);
  });

  it('commitment depends on nonce', () => {
    const probeSet = generateProbeSet({
      service: 's',
      count: 6,
      seed: 'nonce',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    const a = computeProbeCommitment(probeSet);
    const b = computeProbeCommitment({ ...probeSet, nonce: 'deadbeef' });
    expect(a).not.toBe(b);
  });
});
