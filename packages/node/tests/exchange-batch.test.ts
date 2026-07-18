import { AbiCoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  computeBatchRoot,
  computeExchangeLeaf,
  type ExchangeRecord,
} from '../src/verification/exchange-batch.js';
import { buildFixtureRecords } from './helpers/exchange-fixtures.js';

/**
 * Pinned roots for the shared deterministic fixture (buildFixtureRecords).
 * The Solidity test suite (AntseedVerifierRegistry anchor tests) pins these
 * SAME values — the leaf/root derivation is frozen with the contract. If a
 * change here is ever intentional, re-pin BOTH suites together.
 */
const PINNED_FIXTURE_ROOTS: Record<number, string> = {
  1: '0x4e2518cd3642ea7a18329b21f42d11c5236a5ff9d63ee20e791ac0bcb07a380e',
  2: '0xb5f671cd8da3fa71c98304904f9c1402a834de3c55580792894e55f1ec42fc38',
  3: '0xb85932b50baae5041129b6c74572dae0f3b15c907cc5bf5269857e69a4721705',
  5: '0xccb6374afccfe2dbddf6e11aebeb79a3b44120c8305d735f2aaaa4849a11b241',
};

describe('buildFixtureRecords', () => {
  it('derives record i from the documented deterministic recipe', () => {
    const [first, second] = buildFixtureRecords(2);
    expect(first).toEqual({
      agentId: 1n,
      requestHash: keccak256(toUtf8Bytes('req-0')),
      responseHash: keccak256(toUtf8Bytes('res-0')),
      responseAuthSig: concat([
        keccak256(toUtf8Bytes('sig-0')),
        keccak256(toUtf8Bytes('sig-0-s')),
        '0x1b',
      ]),
    });
    expect(second.agentId).toBe(2n);
    expect(second.requestHash).toBe(keccak256(toUtf8Bytes('req-1')));
    // Signatures are 65 bytes, like a real (r,s,v) ECDSA signature.
    expect((first.responseAuthSig.length - 2) / 2).toBe(65);
  });
});

describe('computeExchangeLeaf', () => {
  it('matches an independent abi.encode(uint256,bytes32,bytes32,bytes32) recomputation', () => {
    const record: ExchangeRecord = buildFixtureRecords(1)[0];
    const expected = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'bytes32', 'bytes32', 'bytes32'],
        [record.agentId, record.requestHash, record.responseHash, keccak256(record.responseAuthSig)],
      ),
    );
    expect(computeExchangeLeaf(record)).toBe(expected);
  });

  it('binds the signature: a different sig changes the leaf', () => {
    const [record] = buildFixtureRecords(1);
    const tampered: ExchangeRecord = {
      ...record,
      responseAuthSig: concat([
        keccak256(toUtf8Bytes('sig-0')),
        keccak256(toUtf8Bytes('sig-0-s')),
        '0x1c',
      ]),
    };
    expect(computeExchangeLeaf(tampered)).not.toBe(computeExchangeLeaf(record));
  });
});

describe('computeBatchRoot', () => {
  it('throws on an empty batch (contract reverts with EmptyBatch)', () => {
    expect(() => computeBatchRoot([])).toThrow(/empty/i);
  });

  it.each([1, 2, 3, 5])('pins the fixture root for %i record(s)', (n) => {
    expect(computeBatchRoot(buildFixtureRecords(n))).toBe(PINNED_FIXTURE_ROOTS[n]);
  });

  it('root of a single record IS its leaf', () => {
    const records = buildFixtureRecords(1);
    expect(computeBatchRoot(records)).toBe(computeExchangeLeaf(records[0]));
  });

  it('pairs nodes with keccak256 over their 32-byte concatenation', () => {
    const records = buildFixtureRecords(2);
    const [l0, l1] = records.map(computeExchangeLeaf);
    expect(computeBatchRoot(records)).toBe(keccak256(concat([l0, l1])));
  });

  it('promotes an odd trailing node unchanged to the next level', () => {
    const records = buildFixtureRecords(3);
    const [l0, l1, l2] = records.map(computeExchangeLeaf);
    // Level 0: [l0, l1, l2] → level 1: [H(l0‖l1), l2] → root: H(H(l0‖l1)‖l2)
    expect(computeBatchRoot(records)).toBe(keccak256(concat([keccak256(concat([l0, l1])), l2])));
  });

  it('is order-sensitive (swapped records change the root)', () => {
    const records = buildFixtureRecords(2);
    expect(computeBatchRoot([records[1], records[0]])).not.toBe(computeBatchRoot(records));
  });

  it('handles a 1000-record batch: 32-byte hex root, deterministic across calls', () => {
    const first = computeBatchRoot(buildFixtureRecords(1000));
    const second = computeBatchRoot(buildFixtureRecords(1000));
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});
