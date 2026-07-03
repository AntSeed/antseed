import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  canonicalHashBytes32,
  canonicalJsonStringify,
  sha256Hex,
} from '../src/canonical-json.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys and preserves array order', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,2]},"b":1}',
    );
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('emits no whitespace', () => {
    const out = canonicalJsonStringify({ a: [1, { b: 'x y' }] });
    expect(out.replace(/"[^"]*"/g, '""')).not.toMatch(/\s/);
  });

  it('serializes primitives like JSON', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify(1.5)).toBe('1.5');
    expect(canonicalJsonStringify(-0.25)).toBe('-0.25');
    expect(canonicalJsonStringify('a"b')).toBe('"a\\"b"');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalJsonStringify(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify({ a: -Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify([NaN])).toThrow(/non-finite/);
  });

  it('skips undefined object properties like JSON.stringify', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('throws on undefined, function, and bigint elsewhere', () => {
    expect(() => canonicalJsonStringify(undefined)).toThrow(/unsupported/);
    expect(() => canonicalJsonStringify([undefined])).toThrow(/unsupported/);
    expect(() => canonicalJsonStringify({ a: [() => 1] })).toThrow(/unsupported/);
    expect(() => canonicalJsonStringify({ a: 1n })).toThrow(/unsupported/);
  });

  it('honors toJSON (Date)', () => {
    expect(canonicalJsonStringify(new Date('2026-06-14T00:00:00.000Z'))).toBe(
      '"2026-06-14T00:00:00.000Z"',
    );
  });

  it('is stable regardless of key insertion order', () => {
    const a = { x: 1, y: { b: 2, a: 3 } };
    const b: Record<string, unknown> = {};
    b['y'] = { a: 3, b: 2 };
    b['x'] = 1;
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });
});

describe('sha256Hex / canonicalHash / canonicalHashBytes32', () => {
  it('matches the known sha256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes bytes and strings identically for the same UTF-8 content', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });

  it('produces stable canonical hashes (fixed expected values)', () => {
    const value = { b: 1, a: { d: [1, 2], c: 'x' } };
    expect(canonicalHash(value)).toBe(
      'sha256:830c7b7f8c79059841a32e4738f35625c6e5bb256f2821b221cadaef7411d44d',
    );
    expect(canonicalHashBytes32(value)).toBe(
      '0x830c7b7f8c79059841a32e4738f35625c6e5bb256f2821b221cadaef7411d44d',
    );
  });

  it('canonicalHashBytes32 is a 0x-prefixed 64-hex string', () => {
    expect(canonicalHashBytes32({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
