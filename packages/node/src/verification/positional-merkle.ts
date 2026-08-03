import { concat, getBytes, keccak256, solidityPackedKeccak256 } from 'ethers';

export interface PositionalMerkleTree {
  root: string;
  proofs: string[][];
  capacity: number;
  depth: number;
}

function hashNode(left: string, right: string): string {
  return keccak256(concat([getBytes('0x01'), getBytes(left), getBytes(right)]));
}

function paddingLeaf(index: number): string {
  return solidityPackedKeccak256(['bytes1', 'uint16'], ['0x00', index]);
}

export function buildPositionalMerkleTree(leaves: readonly string[]): PositionalMerkleTree {
  if (leaves.length === 0 || leaves.length > 128) throw new Error('Merkle tree requires 1 to 128 leaves');
  let capacity = 1;
  let depth = 0;
  while (capacity < leaves.length) {
    capacity <<= 1;
    depth += 1;
  }
  const nodes = new Array<string>(capacity * 2);
  for (let index = 0; index < capacity; index += 1) {
    const leaf = index < leaves.length ? leaves[index]! : paddingLeaf(index);
    if (!/^0x[0-9a-fA-F]{64}$/.test(leaf)) throw new Error(`invalid leaf at index ${index}`);
    nodes[capacity + index] = leaf;
  }
  for (let index = capacity - 1; index > 0; index -= 1) {
    nodes[index] = hashNode(nodes[index * 2]!, nodes[index * 2 + 1]!);
  }
  const proofs = leaves.map((_leaf, index) => {
    const proof: string[] = [];
    let cursor = capacity + index;
    for (let level = 0; level < depth; level += 1) {
      proof.push(nodes[cursor ^ 1]!);
      cursor >>= 1;
    }
    return proof;
  });
  return { root: nodes[1]!, proofs, capacity, depth };
}

export function verifyPositionalMerkleProof(input: {
  root: string;
  leaf: string;
  jobIndex: number;
  jobCount: number;
  proof: readonly string[];
}): boolean {
  if (input.jobCount <= 0 || input.jobCount > 128 || input.jobIndex < 0 || input.jobIndex >= input.jobCount) return false;
  let capacity = 1;
  let depth = 0;
  while (capacity < input.jobCount) {
    capacity <<= 1;
    depth += 1;
  }
  if (input.proof.length !== depth) return false;
  let computed = input.leaf;
  let index = input.jobIndex;
  for (const sibling of input.proof) {
    computed = (index & 1) === 0 ? hashNode(computed, sibling) : hashNode(sibling, computed);
    index >>= 1;
  }
  return computed.toLowerCase() === input.root.toLowerCase();
}
