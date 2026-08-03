import { concat, getBytes, keccak256, solidityPackedKeccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';
import { buildPositionalMerkleTree, verifyPositionalMerkleProof } from '../src/verification/positional-merkle.js';

function leaves(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => keccak256(toUtf8Bytes(`job-${index}`)));
}

function hashNode(left: string, right: string): string {
  return keccak256(concat([getBytes('0x01'), getBytes(left), getBytes(right)]));
}

describe('positional Merkle proofs', () => {
  it.each([10, 20, 30, 50])('verifies every committed job for %i jobs', (jobCount) => {
    const jobLeaves = leaves(jobCount);
    const tree = buildPositionalMerkleTree(jobLeaves);
    expect(tree.capacity).toBe(2 ** Math.ceil(Math.log2(jobCount)));
    expect(tree.proofs).toHaveLength(jobCount);
    for (let jobIndex = 0; jobIndex < jobCount; jobIndex += 1) {
      expect(verifyPositionalMerkleProof({
        root: tree.root,
        leaf: jobLeaves[jobIndex]!,
        jobIndex,
        jobCount,
        proof: tree.proofs[jobIndex]!,
      })).toBe(true);
    }
  });

  it('uses deterministic padding leaves for a non-power-of-two job count', () => {
    const jobLeaves = leaves(3);
    const padding = solidityPackedKeccak256(['bytes1', 'uint16'], ['0x00', 3]);
    const expectedRoot = hashNode(hashNode(jobLeaves[0]!, jobLeaves[1]!), hashNode(jobLeaves[2]!, padding));
    expect(buildPositionalMerkleTree(jobLeaves).root).toBe(expectedRoot);
  });

  it('rejects incorrect side, index, depth, leaf, and job count', () => {
    const jobLeaves = leaves(10);
    const tree = buildPositionalMerkleTree(jobLeaves);
    const valid = {
      root: tree.root,
      leaf: jobLeaves[2]!,
      jobIndex: 2,
      jobCount: 10,
      proof: tree.proofs[2]!,
    };
    expect(verifyPositionalMerkleProof({ ...valid, proof: tree.proofs[3]! })).toBe(false);
    expect(verifyPositionalMerkleProof({ ...valid, jobIndex: 3 })).toBe(false);
    expect(verifyPositionalMerkleProof({ ...valid, proof: valid.proof.slice(1) })).toBe(false);
    expect(verifyPositionalMerkleProof({ ...valid, leaf: keccak256(toUtf8Bytes('tampered')) })).toBe(false);
    expect(verifyPositionalMerkleProof({ ...valid, jobCount: 0 })).toBe(false);
  });
});
