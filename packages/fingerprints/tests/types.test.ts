import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalProbeSetJson,
  computeEvidenceHash,
  computeProbeCommitment,
  computeProbeSetId,
  computeReferenceId,
  isMatchEntry,
  isMatchVector,
  verdictFromCode,
  verdictToCode,
  type EvidenceBundle,
  type EvidenceProbeExchange,
  type FingerprintReference,
  type FingerprintVerdict,
  type KbfProbe,
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
        cohortVerdict: cohort.verdicts[s]!.verdict,
        stats: cohort.verdicts[s]!.stats,
      })),
      cohort,
      cohortOptions: {
        alpha: 0.05,
        minConsensusProbes: 5,
        minCoverage: 0.5,
        epsilon: 0.02,
        minConsensusSellers: 3,
      },
      maxProbesPerRequest: 3,
      createdAt: '2026-07-03T00:00:00.000Z',
    };
  }

  it('is stable across runs (fixed expected hash)', () => {
    const hash = computeEvidenceHash(makeBundle());
    // Pinned over the HKDF/HMAC_DRBG derivation (prng.ts). If this breaks, the
    // wire format changed — bump the HKDF salt version, don't silently re-pin.
    // (Re-pinned 2026-07-14 (transparent-audits review): EvidenceBundle now
    // carries the effective `cohortOptions` and `maxProbesPerRequest`, and
    // each EvidenceSeller carries `cohortVerdict`, so a re-runner re-grades
    // with the auditor's exact options and recomputes the reference/cohort
    // combination behind a DIFF instead of blanket-trusting it.
    // Previously: nonce derivation binding (service, count, source id, domains
    // filter) alongside the exclude set, round-2 review — 0x670a7f33…7d78.
    // Before that: content-binding probeSetId/commitment + hashed
    // exclude-aware nonce, PR #720.)
    expect(hash).toBe('0x43abf84e542c5fe6056369d5cf27ed7970d2635427f2bfe8bc7dda5bcd53319c');
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

  // The CLI audit runner persists per-seller `exchanges` (full request/response
  // bytes + the signed ResponseAuth payload) and `fullyAuthenticated` inside
  // the hashed bundle. Both must be part of the exported schema, or anyone
  // reconstructing a bundle from the published types computes a different
  // evidenceHash than the one attested on-chain.
  it('declares per-seller exchanges and fullyAuthenticated as schema fields', () => {
    const bundle = makeBundle();
    const base = computeEvidenceHash(bundle);
    const exchange: EvidenceProbeExchange = {
      requestId: 'req-0',
      request: {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        bodyBase64: 'e30=',
      },
      response: { statusCode: 200, headers: {}, bodyBase64: 'e30=' },
      responseAuth: {
        version: 1,
        requestId: 'req-0',
        buyerPeerId: '0xbuyer',
        sellerPeerId: '0xaaa',
        advertisedService: 'kimi-k2',
        provider: 'openai',
        statusCode: 200,
        requestHash: '0x00',
        responseHash: '0x10',
        responseStartedAt: 1,
        responseCompletedAt: 2,
        signature: '0xsig',
      },
    };
    const withEvidence: EvidenceBundle = {
      ...bundle,
      sellers: bundle.sellers.map((seller) => ({
        ...seller,
        exchanges: [exchange],
        fullyAuthenticated: true,
      })),
    };
    // The new fields are hash-bearing…
    expect(computeEvidenceHash(withEvidence)).not.toBe(base);
    // …and a JSON round-trip (a third party re-reading the published bundle)
    // reproduces the identical hash.
    expect(
      computeEvidenceHash(JSON.parse(JSON.stringify(withEvidence)) as EvidenceBundle),
    ).toBe(computeEvidenceHash(withEvidence));
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

  it('commitment IS the sha256 of the canonical probe-set reveal bytes', () => {
    const probeSet = generateProbeSet({
      service: 's',
      count: 6,
      seed: 'reveal-bytes',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    const revealBytes = canonicalProbeSetJson(probeSet);
    const hash = createHash('sha256').update(revealBytes, 'utf8').digest('hex');
    expect(computeProbeCommitment(probeSet)).toBe(`0x${hash}`);
    // The reveal string binds exactly {service, probes, nonce} — nothing else.
    expect(JSON.parse(revealBytes)).toEqual({
      service: probeSet.service,
      probes: probeSet.probes,
      nonce: probeSet.nonce,
    });
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

  // Post-hoc content mutations a cheating verifier could try after seeing
  // responses. Every scoring-relevant field must be bound by BOTH the
  // probe-set id and the on-chain commitment.
  const CONTENT_MUTATIONS: ReadonlyArray<[string, (p: KbfProbe) => KbfProbe]> = [
    ['id', (p) => ({ ...p, id: `${p.id}-forged` })],
    ['name', (p) => ({ ...p, name: `${p.name} (v2)` })],
    ['domain', (p) => ({ ...p, domain: `${p.domain}_alt` })],
    ['template', (p) => ({ ...p, template: p.template.replace('___', 'exactly ___') })],
    ['consensus', (p) => ({ ...p, consensus: p.consensus + 1 })],
    ['range low', (p) => ({ ...p, range: [p.range[0] - 1, p.range[1]] as [number, number] })],
    ['range high', (p) => ({ ...p, range: [p.range[0], p.range[1] + 1] as [number, number] })],
    [
      'tolerance mode',
      (p) => ({
        ...p,
        tolerance: { ...p.tolerance, mode: p.tolerance.mode === 'absolute' ? 'relative' : 'absolute' },
      }),
    ],
    [
      'tolerance value (tightened)',
      (p) => ({ ...p, tolerance: { ...p.tolerance, value: p.tolerance.value / 2 } }),
    ],
    ['extension field', (p) => ({ ...p, contrast: { forged: true } })],
  ];

  it.each(CONTENT_MUTATIONS)(
    'mutating probe %s changes both the probe-set id and the commitment',
    (_field, mutate) => {
      const probeSet = generateProbeSet({
        service: 's',
        count: 6,
        seed: 'content-binding',
        createdAt: '2026-07-03T00:00:00.000Z',
      });
      const mutatedProbes = probeSet.probes.map((p, i) => (i === 2 ? mutate(p) : p));

      expect(computeProbeSetId('s', mutatedProbes)).not.toBe(
        computeProbeSetId('s', probeSet.probes),
      );
      expect(computeProbeCommitment({ ...probeSet, probes: mutatedProbes })).not.toBe(
        computeProbeCommitment(probeSet),
      );
    },
  );

  it('probeSetId and commitment depend on the service', () => {
    const probeSet = generateProbeSet({
      service: 's',
      count: 6,
      seed: 'service-binding',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    expect(computeProbeSetId('other', probeSet.probes)).not.toBe(probeSet.probeSetId);
    expect(computeProbeCommitment({ ...probeSet, service: 'other' })).not.toBe(
      computeProbeCommitment(probeSet),
    );
  });
});

describe('match vector guards', () => {
  it('isMatchEntry accepts exactly 0, 1, null', () => {
    expect(isMatchEntry(0)).toBe(true);
    expect(isMatchEntry(1)).toBe(true);
    expect(isMatchEntry(null)).toBe(true);
  });

  it('isMatchEntry rejects other truthy/falsy values', () => {
    for (const bad of [2, -1, 0.5, true, false, '1', '0', undefined, NaN, [], {}]) {
      expect(isMatchEntry(bad), String(bad)).toBe(false);
    }
  });

  it('isMatchVector accepts only arrays of valid entries', () => {
    expect(isMatchVector([])).toBe(true);
    expect(isMatchVector([1, 0, null, 1])).toBe(true);
    expect(isMatchVector([1, 2, 0])).toBe(false);
    expect(isMatchVector([true])).toBe(false);
    expect(isMatchVector(['1'])).toBe(false);
    expect(isMatchVector('10')).toBe(false);
    expect(isMatchVector(null)).toBe(false);
  });
});
