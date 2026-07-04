import { describe, expect, it } from 'vitest';
import { createRng, deriveHex, deriveSeedMaterial } from '../src/prng.js';

describe('deriveSeedMaterial / deriveHex (RFC 5869 HKDF-SHA256)', () => {
  it('is deterministic for the same (seed, domain)', () => {
    expect(deriveHex('seed-a', 'probe-set')).toBe(deriveHex('seed-a', 'probe-set'));
    expect(deriveSeedMaterial('seed-a', 'probe-set').equals(deriveSeedMaterial('seed-a', 'probe-set'))).toBe(true);
  });

  it('domain-separates: same seed, different domain → different output', () => {
    expect(deriveHex('seed-a', 'probe-set')).not.toBe(deriveHex('seed-a', 'probe-set-nonce'));
  });

  it('different seeds → different output', () => {
    expect(deriveHex('seed-a', 'probe-set')).not.toBe(deriveHex('seed-b', 'probe-set'));
  });

  it('honors the requested length', () => {
    expect(deriveHex('seed-a', 'x', 16)).toHaveLength(32);
    expect(deriveSeedMaterial('seed-a', 'x', 64)).toHaveLength(64);
  });
});

describe('createRng (HMAC_DRBG, SP 800-90A)', () => {
  it('is deterministic: same (seed, domain) → identical stream', () => {
    const a = createRng('seed', 'stealth');
    const b = createRng('seed', 'stealth');
    expect(a.nextBytes(64).equals(b.nextBytes(64))).toBe(true);
    expect(a.nextInt(1000)).toBe(b.nextInt(1000));
    expect(a.nextFloat()).toBe(b.nextFloat());
  });

  it('domain-separates streams from the same seed', () => {
    const a = createRng('seed', 'stealth');
    const b = createRng('seed', 'probe-set');
    expect(a.nextBytes(32).equals(b.nextBytes(32))).toBe(false);
  });

  it('nextInt stays in [0, max) and reaches every value of a small range', () => {
    const rng = createRng('seed', 'int-test');
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('nextInt rejects invalid bounds', () => {
    const rng = createRng('seed', 'int-test');
    expect(() => rng.nextInt(0)).toThrow(/maxExclusive/);
    expect(() => rng.nextInt(-1)).toThrow(/maxExclusive/);
    expect(() => rng.nextInt(1.5)).toThrow(/maxExclusive/);
  });

  it('nextFloat stays in [0, 1)', () => {
    const rng = createRng('seed', 'float-test');
    for (let i = 0; i < 200; i++) {
      const v = rng.nextFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('shuffle is a deterministic permutation', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = createRng('seed', 'shuffle').shuffle([...items]);
    const b = createRng('seed', 'shuffle').shuffle([...items]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(a).not.toEqual(items); // astronomically unlikely to be identity
  });

  // Golden values pin the wire format: committed probe sets and stealth
  // requests must reproduce byte-identically across releases. If this test
  // breaks, the derivation changed — bump the HKDF salt version and treat old
  // evidence bundles as a prior format, do not silently re-pin.
  it('matches pinned golden outputs', () => {
    expect(deriveHex('golden-seed', 'golden-domain', 16)).toBe('f86c84cace49b109ab0a5ee5078b5b18');
    expect(createRng('golden-seed', 'golden-domain').nextBytes(8).toString('hex')).toBe('539a57ce391c586b');
  });
});
