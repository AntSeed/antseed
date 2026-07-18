import { AbiCoder, concat, keccak256 } from 'ethers';

/**
 * One anchored probe exchange: the verifier posts these on-chain as calldata
 * (AntseedVerifierRegistry.anchorExchangeBatch) and the contract recomputes
 * the Merkle root from them, so root ↔ data binding is on-chain-verified.
 * Mirrors the Solidity `ExchangeRecord` struct — frozen with it.
 */
export interface ExchangeRecord {
  agentId: bigint;
  /** bytes32 hex — hash of the verifier-crafted request. */
  requestHash: string;
  /** bytes32 hex — hash of the seller's response body. */
  responseHash: string;
  /** 65-byte ECDSA signature over the ResponseAuth payload, hex. */
  responseAuthSig: string;
}

const abiCoder = AbiCoder.defaultAbiCoder();

/**
 * TS mirror of the contract's leaf derivation:
 * `keccak256(abi.encode(agentId, requestHash, responseHash, keccak256(responseAuthSig)))`.
 * The variable-length signature is collapsed to its keccak so every leaf is a
 * fixed 4×32-byte encoding. MUST stay byte-identical to
 * AntseedVerifierRegistry's on-chain computation.
 */
export function computeExchangeLeaf(record: ExchangeRecord): string {
  return keccak256(
    abiCoder.encode(
      ['uint256', 'bytes32', 'bytes32', 'bytes32'],
      [record.agentId, record.requestHash, record.responseHash, keccak256(record.responseAuthSig)],
    ),
  );
}

/**
 * TS mirror of the contract's Merkle root: pairwise keccak256 over the
 * concatenated 32-byte nodes of each level; an odd trailing node is promoted
 * unchanged to the next level. Throws on an empty batch (the contract
 * reverts with EmptyBatch).
 */
export function computeBatchRoot(records: ExchangeRecord[]): string {
  if (records.length === 0) {
    throw new Error('Cannot compute batch root of an empty exchange batch');
  }
  let level: string[] = records.map(computeExchangeLeaf);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(keccak256(concat([level[i] as string, level[i + 1] as string])));
    }
    if (level.length % 2 === 1) {
      next.push(level[level.length - 1] as string);
    }
    level = next;
  }
  return level[0] as string;
}
