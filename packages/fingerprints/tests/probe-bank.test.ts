import { describe, expect, it } from 'vitest';
import { generateProbeSet, PROBE_BANK, PROBE_BANK_DOMAINS } from '../src/probe-bank.js';
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
