/**
 * Deterministic randomness shared by probe selection, compositional
 * generation, and the stealth request engine — built from standard, citable
 * primitives rather than ad-hoc constructions:
 *
 * - Seed derivation: HKDF-SHA256 (RFC 5869), domain-separated via `info`, so
 *   independent consumers of one seed can never correlate or collide.
 * - Byte stream: HMAC_DRBG with SHA-256 (NIST SP 800-90A §10.1.2), full
 *   256-bit state — not a 32-bit toy PRNG.
 * - Integers: rejection sampling over the stream, so draws are exactly
 *   uniform (no modulo / float truncation bias).
 * - Shuffle: Fisher–Yates (Knuth TAOCP vol. 2, Algorithm P).
 *
 * Everything is a pure function of its (seed, domain) inputs — no
 * `Math.random`, no `Date` — so any hashed or committed artifact reproduces
 * byte-identically for later evidence re-verification.
 */

import { createHmac, hkdfSync } from 'node:crypto';

/** HKDF salt: fixed, public, versioned. Bump on any wire-format change. */
const HKDF_SALT = 'antseed-fingerprints/v1';

const HASH_LEN = 32;
const EMPTY = Buffer.alloc(0);
const TWO_32 = 0x1_0000_0000;

/**
 * Derive `length` bytes of keying material from a seed string via RFC 5869
 * HKDF-SHA256. `domain` feeds the HKDF `info` parameter, giving each consumer
 * (probe selection, nonces, stealth phrasing, …) an independent stream from
 * the same seed.
 */
export function deriveSeedMaterial(seed: string, domain: string, length = HASH_LEN): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(seed, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(domain, 'utf8'), length),
  );
}

/** {@link deriveSeedMaterial} as lowercase hex — e.g. probe-set commitment nonces. */
export function deriveHex(seed: string, domain: string, length = HASH_LEN): string {
  return deriveSeedMaterial(seed, domain, length).toString('hex');
}

export interface DeterministicRng {
  /** Next `length` bytes of the deterministic stream. */
  nextBytes(length: number): Buffer;
  /** Uniform integer in [0, maxExclusive) via rejection sampling. */
  nextInt(maxExclusive: number): number;
  /** Uniform float in [0, 1) with the full 53 bits of double precision. */
  nextFloat(): number;
  /** In-place Fisher–Yates shuffle; returns `items` for chaining. */
  shuffle<T>(items: T[]): T[];
}

/**
 * Instantiate a deterministic RNG for (seed, domain): HKDF-derived seed
 * material feeding an HMAC_DRBG (SHA-256) per NIST SP 800-90A §10.1.2.
 * Reseeding and additional input are omitted — seeds here are single-use per
 * committed artifact, and unpredictability comes from the caller's entropy
 * (a fresh `randomBytes` seed per audit round), not from this construction.
 */
export function createRng(seed: string, domain: string): DeterministicRng {
  // HMAC_DRBG instantiate: K = 0x00…, V = 0x01…, then update(seedMaterial).
  let K = Buffer.alloc(HASH_LEN, 0x00);
  let V = Buffer.alloc(HASH_LEN, 0x01);

  const update = (provided: Buffer): void => {
    K = createHmac('sha256', K).update(V).update(Buffer.from([0x00])).update(provided).digest();
    V = createHmac('sha256', K).update(V).digest();
    if (provided.length > 0) {
      K = createHmac('sha256', K).update(V).update(Buffer.from([0x01])).update(provided).digest();
      V = createHmac('sha256', K).update(V).digest();
    }
  };
  update(deriveSeedMaterial(seed, domain));

  const nextBytes = (length: number): Buffer => {
    if (!Number.isInteger(length) || length <= 0) {
      throw new Error(`nextBytes: length must be a positive integer, got ${length}`);
    }
    const out = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      V = createHmac('sha256', K).update(V).digest();
      const n = Math.min(V.length, length - filled);
      V.copy(out, filled, 0, n);
      filled += n;
    }
    update(EMPTY); // SP 800-90A: update state after every generate call
    return out;
  };

  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > TWO_32) {
      throw new Error(`nextInt: maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`);
    }
    // Rejection sampling: only accept draws below the largest multiple of
    // maxExclusive that fits in 32 bits, so the modulo is exactly uniform.
    const limit = Math.floor(TWO_32 / maxExclusive) * maxExclusive;
    let draw = nextBytes(4).readUInt32BE(0);
    while (draw >= limit) {
      draw = nextBytes(4).readUInt32BE(0);
    }
    return draw % maxExclusive;
  };

  const nextFloat = (): number => {
    // 53 uniform bits (27 + 26) → [0, 1), the standard double conversion.
    const bytes = nextBytes(8);
    const hi = bytes.readUInt32BE(0) >>> 5;
    const lo = bytes.readUInt32BE(4) >>> 6;
    return (hi * 0x400_0000 + lo) / 0x20_0000_0000_0000;
  };

  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  };

  return { nextBytes, nextInt, nextFloat, shuffle };
}
