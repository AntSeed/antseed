import { type AbstractSigner, type TypedDataDomain, AbiCoder, keccak256 } from 'ethers';
import type { Identity } from '../../p2p/identity.js';
import { signData, verifySignature } from '../../p2p/identity.js';

// =========================================================================
// EIP-712 Types — AntSeed MetadataAuth (reputation attestation)
// =========================================================================

export const METADATA_AUTH_TYPES = {
  MetadataAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
};

/** @deprecated Use METADATA_AUTH_TYPES */
export const SPENDING_AUTH_TYPES = METADATA_AUTH_TYPES;

// =========================================================================
// Message interfaces
// =========================================================================

export interface MetadataAuthMessage {
  channelId: string;
  cumulativeAmount: bigint;
  metadataHash: string; // bytes32 hex
}

/** @deprecated Use MetadataAuthMessage */
export type SpendingAuthMessage = MetadataAuthMessage;

// =========================================================================
// Metadata encoding
// =========================================================================

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

// =========================================================================
// Channel ID computation (must match AntseedSessions.computeChannelId)
// =========================================================================

/**
 * Compute the deterministic channelId.
 * Must match: keccak256(abi.encode(buyer, seller, salt))
 */
export function computeChannelId(
  buyer: string,
  seller: string,
  salt: string,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['address', 'address', 'bytes32'],
    [buyer, seller, salt],
  ));
}

// =========================================================================
// EIP-712 Domain helpers
// =========================================================================

export function makeSessionsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedSessions',
    version: '6',
    chainId,
    verifyingContract: contractAddress,
  };
}

// =========================================================================
// Signing functions — EIP-712 (on-chain)
// =========================================================================

export async function signMetadataAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: MetadataAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, METADATA_AUTH_TYPES, msg);
}

/** @deprecated Use signMetadataAuth */
export const signSpendingAuth = signMetadataAuth;

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
