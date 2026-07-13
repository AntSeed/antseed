import { describe, expect, it } from 'vitest';
import { generateProbeSet, PROBE_BANK, PROBE_BANK_DOMAINS } from '../src/probe-bank.js';
import { compositionalProbeSource } from '../src/compositional/source.js';
import { computeProbeCommitment, computeProbeSetId } from '../src/types.js';

const CREATED_AT = '2026-07-03T00:00:00.000Z';

describe('PROBE_BANK', () => {
  it('has at least 60 probes across at least 5 domains', () => {
    expect(PROBE_BANK.length).toBeGreaterThanOrEqual(60);
    expect(PROBE_BANK_DOMAINS.length).toBeGreaterThanOrEqual(5);
  });

  it('has unique probe ids', () => {
    const ids = PROBE_BANK.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every probe is well-formed', () => {
    for (const probe of PROBE_BANK) {
      expect(probe.template).toContain('___');
      expect(probe.id).toContain(':');
      expect(probe.range[0]).toBeLessThan(probe.range[1]);
      expect(probe.consensus).toBeGreaterThanOrEqual(probe.range[0]);
      expect(probe.consensus).toBeLessThanOrEqual(probe.range[1]);
      expect(['absolute', 'relative']).toContain(probe.tolerance.mode);
      expect(probe.tolerance.value).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(probe.consensus)).toBe(true);
    }
  });
});

describe('generateProbeSet', () => {
  it('same seed produces an identical probe set', () => {
    const params = { service: 'kimi-k2', count: 24, seed: 'seed-1', createdAt: CREATED_AT };
    const a = generateProbeSet(params);
    const b = generateProbeSet(params);
    expect(a).toEqual(b);
    expect(a.probes.map((p) => p.id)).toEqual(b.probes.map((p) => p.id));
    expect(a.nonce).toBe(b.nonce);
    expect(a.probeSetId).toBe(b.probeSetId);
  });

  it('different seeds produce different subsets or order', () => {
    const a = generateProbeSet({ service: 's', count: 24, seed: 'seed-1', createdAt: CREATED_AT });
    const b = generateProbeSet({ service: 's', count: 24, seed: 'seed-2', createdAt: CREATED_AT });
    expect(a.probes.map((p) => p.id)).not.toEqual(b.probes.map((p) => p.id));
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.probeSetId).not.toBe(b.probeSetId);
  });

  it('selects the requested count without duplicates', () => {
    const set = generateProbeSet({ service: 's', count: 30, seed: 'x', createdAt: CREATED_AT });
    expect(set.probes).toHaveLength(30);
    expect(new Set(set.probes.map((p) => p.id)).size).toBe(30);
  });

  it('respects a domain filter', () => {
    const set = generateProbeSet({
      service: 's',
      count: 10,
      seed: 'x',
      domains: ['chemistry_mp', 'biology_2n'],
      createdAt: CREATED_AT,
    });
    for (const probe of set.probes) {
      expect(['chemistry_mp', 'biology_2n']).toContain(probe.domain);
    }
  });

  it('rejects invalid counts', () => {
    expect(() => generateProbeSet({ service: 's', count: 0, seed: 'x' })).toThrow();
    expect(() => generateProbeSet({ service: 's', count: 10000, seed: 'x' })).toThrow();
    expect(() =>
      generateProbeSet({ service: 's', count: 13, seed: 'x', domains: ['chemistry_mp'] }),
    ).toThrow(/exceeds/);
  });

  it('probeSetId is the order-sensitive canonical hash of {service, probeIds}', () => {
    const set = generateProbeSet({ service: 's', count: 12, seed: 'x', createdAt: CREATED_AT });
    expect(set.probeSetId).toBe(computeProbeSetId('s', set.probes));
    const reversed = [...set.probes].reverse();
    expect(computeProbeSetId('s', reversed)).not.toBe(set.probeSetId);
  });

  it('same seed with a different exclude set derives a different nonce', () => {
    const base = generateProbeSet({ service: 's', count: 10, seed: 'rotate', createdAt: CREATED_AT });
    // Rotation: the first round's probes are excluded, seed unchanged. The new
    // set must NOT be blinded with the already-revealed nonce.
    const exclude = new Set(base.probes.slice(0, 5).map((p) => p.id));
    const rotated = generateProbeSet({
      service: 's',
      count: 10,
      seed: 'rotate',
      exclude,
      createdAt: CREATED_AT,
    });
    expect(rotated.nonce).not.toBe(base.nonce);
    expect(computeProbeCommitment(rotated)).not.toBe(computeProbeCommitment(base));

    // Still deterministic: the same (seed, exclude) pair reproduces the nonce.
    const again = generateProbeSet({
      service: 's',
      count: 10,
      seed: 'rotate',
      exclude: new Set([...exclude]),
      createdAt: CREATED_AT,
    });
    expect(again.nonce).toBe(rotated.nonce);

    // Exclude-set iteration order must not matter (canonical serialization).
    const shuffledExclude = new Set([...exclude].reverse());
    expect(
      generateProbeSet({
        service: 's',
        count: 10,
        seed: 'rotate',
        exclude: shuffledExclude,
        createdAt: CREATED_AT,
      }).nonce,
    ).toBe(rotated.nonce);
  });

  it('same (seed, exclude) with a different service derives a different nonce', () => {
    // Two audits sharing a seed but probing different services are DIFFERENT
    // probe sets; if they shared a nonce, opening one commitment would void
    // the sibling's blinding.
    const a = generateProbeSet({ service: 'svc-a', count: 10, seed: 'shared', createdAt: CREATED_AT });
    const b = generateProbeSet({ service: 'svc-b', count: 10, seed: 'shared', createdAt: CREATED_AT });
    expect(a.nonce).not.toBe(b.nonce);
    expect(computeProbeCommitment(a)).not.toBe(computeProbeCommitment(b));
  });

  it('same (seed, exclude, service) with a different count derives a different nonce', () => {
    // deterministicSample gives count=10 a strict prefix of count=20 for the
    // same seed, so the two sets overlap; distinct nonces keep the sibling
    // commitment blinded after one audit opens.
    const small = generateProbeSet({ service: 's', count: 10, seed: 'shared', createdAt: CREATED_AT });
    const large = generateProbeSet({ service: 's', count: 20, seed: 'shared', createdAt: CREATED_AT });
    expect(small.nonce).not.toBe(large.nonce);
    expect(computeProbeCommitment(small)).not.toBe(computeProbeCommitment(large));
  });

  it('same (seed, service, count) with a different source derives a different nonce', () => {
    // The bank and the compositional source select DIFFERENT probe sets from
    // the same seed; sharing a nonce across them would let one opened
    // commitment void the sibling's blinding.
    const bank = generateProbeSet({ service: 's', count: 10, seed: 'shared', createdAt: CREATED_AT });
    const comp = generateProbeSet({
      service: 's',
      count: 10,
      seed: 'shared',
      source: compositionalProbeSource(),
      createdAt: CREATED_AT,
    });
    expect(bank.nonce).not.toBe(comp.nonce);
    expect(computeProbeCommitment(bank)).not.toBe(computeProbeCommitment(comp));
  });

  it('same seed with a different bank domains filter derives a different nonce', () => {
    // The domains filter changes the bank selection, so it is part of the
    // nonce derivation context too; filter order is canonicalized away.
    const all = generateProbeSet({ service: 's', count: 10, seed: 'shared', createdAt: CREATED_AT });
    const filtered = generateProbeSet({
      service: 's',
      count: 10,
      seed: 'shared',
      domains: ['chemistry_mp', 'biology_2n'],
      createdAt: CREATED_AT,
    });
    expect(all.nonce).not.toBe(filtered.nonce);
    expect(
      generateProbeSet({
        service: 's',
        count: 10,
        seed: 'shared',
        domains: ['biology_2n', 'chemistry_mp'],
        createdAt: CREATED_AT,
      }).nonce,
    ).toBe(filtered.nonce);
  });

  it('supports arbitrarily deep exclude sets (hkdf info is a fixed-size hash)', () => {
    // A rotation log thousands of ids deep must not break nonce derivation:
    // hkdfSync caps `info` at 1024 bytes, so the exclude set is hashed, not
    // inlined.
    const deepExclude = new Set(
      Array.from({ length: 3000 }, (_, i) => `rotated:probe-${i.toString().padStart(4, '0')}`),
    );
    const set = generateProbeSet({
      service: 's',
      count: 10,
      seed: 'deep-rotate',
      exclude: deepExclude,
      createdAt: CREATED_AT,
    });
    expect(set.probes).toHaveLength(10);
    expect(set.nonce).not.toBe(
      generateProbeSet({ service: 's', count: 10, seed: 'deep-rotate', createdAt: CREATED_AT })
        .nonce,
    );
  });

  it('probe commitment is stable for the same seed and differs across seeds', () => {
    const a1 = generateProbeSet({ service: 's', count: 16, seed: 'commit', createdAt: CREATED_AT });
    const a2 = generateProbeSet({
      service: 's',
      count: 16,
      seed: 'commit',
      // createdAt intentionally different: commitments must not depend on it.
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    const b = generateProbeSet({ service: 's', count: 16, seed: 'other', createdAt: CREATED_AT });
    expect(computeProbeCommitment(a1)).toBe(computeProbeCommitment(a2));
    expect(computeProbeCommitment(a1)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeProbeCommitment(a1)).not.toBe(computeProbeCommitment(b));
  });
});
