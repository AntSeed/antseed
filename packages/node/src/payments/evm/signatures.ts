import { type AbstractSigner, type TypedDataDomain, AbiCoder, keccak256 } from 'ethers';
import type { Identity } from '../../p2p/identity.js';
import { signData, verifySignature } from '../../p2p/identity.js';

// =========================================================================
// EIP-712 Spending Authorization (on-chain) — verified by contract
// =========================================================================

export const SPENDING_AUTH_TYPES = {
  SpendingAuth: [
    { name: 'sessionId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
};

export interface SpendingAuthMessage {
  sessionId: string;
  cumulativeAmount: bigint;
  metadataHash: string; // bytes32 hex
}

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeLatencyMs: bigint;
  cumulativeRequestCount: bigint;
}

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256'],
    [metadata.cumulativeInputTokens, metadata.cumulativeOutputTokens, metadata.cumulativeLatencyMs, metadata.cumulativeRequestCount],
  );
}

export function computeMetadataHash(metadata: SpendingAuthMetadata): string {
  return keccak256(encodeMetadata(metadata));
}

export const ZERO_METADATA: SpendingAuthMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeLatencyMs: 0n,
  cumulativeRequestCount: 0n,
};

export const ZERO_METADATA_HASH: string = computeMetadataHash(ZERO_METADATA);

export function makeSessionsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedSessions',
    version: '4',
    chainId,
    verifyingContract: contractAddress,
  };
}

export async function signSpendingAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SpendingAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, SPENDING_AUTH_TYPES, msg);
}

// =========================================================================
// Ed25519 signatures (off-chain P2P)
// =========================================================================

export async function signMessageEd25519(
  identity: Identity,
  message: Uint8Array,
): Promise<Uint8Array> {
  return signData(identity.privateKey, message);
}

export async function verifyMessageEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  return verifySignature(publicKey, signature, message);
}
