import { type AbstractSigner, type TypedDataDomain } from 'ethers';
import type { Identity } from '../../p2p/identity.js';
import { signData, verifySignature } from '../../p2p/identity.js';

// =========================================================================
// EIP-712 Spending Authorization (on-chain) — verified by contract
// =========================================================================

export const SPENDING_AUTH_TYPES = {
  SpendingAuth: [
    { name: 'seller', type: 'address' },
    { name: 'sessionId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'cumulativeInputTokens', type: 'uint256' },
    { name: 'cumulativeOutputTokens', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export interface SpendingAuthMessage {
  seller: string;
  sessionId: string;
  cumulativeAmount: bigint;
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  nonce: number;
  deadline: number;
}

export function makeSessionsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedSessions',
    version: '2',
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
