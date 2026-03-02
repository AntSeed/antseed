import { type AbstractSigner, type TypedDataDomain, getBytes } from 'ethers';
import type { Identity } from '../../p2p/identity.js';
import { signData, verifySignature } from '../../p2p/identity.js';

// ── EIP-712 — SpendingAuth (verified by AntseedEscrow.charge()) ───────────────

export const SPENDING_AUTH_TYPES: Record<string, import('ethers').TypedDataField[]> = {
  SpendingAuth: [
    { name: 'seller',    type: 'address' },
    { name: 'sessionId', type: 'bytes32' },
    { name: 'maxAmount', type: 'uint256' },
    { name: 'nonce',     type: 'uint256' },
    { name: 'deadline',  type: 'uint256' },
  ],
};

export interface SpendingAuthMessage {
  seller:    string;
  sessionId: string;
  maxAmount: bigint;
  nonce:     number;
  deadline:  number;
}

export function makeEscrowDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name:              'AntseedEscrow',
    version:           '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export async function signSpendingAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg:    SpendingAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, SPENDING_AUTH_TYPES, msg);
}

// ── Binary message builders for Ed25519 receipt/ack proofs ───────────────────

function writeU64LE(buf: Uint8Array, value: bigint, offset: number): void {
  new DataView(buf.buffer, buf.byteOffset).setBigUint64(offset, value, true);
}

function writeU32LE(buf: Uint8Array, value: number, offset: number): void {
  new DataView(buf.buffer, buf.byteOffset).setUint32(offset, value, true);
}

export function buildReceiptMessage(
  sessionId:    Uint8Array,
  runningTotal: bigint,
  requestCount: number,
  responseHash: Uint8Array,
): Uint8Array {
  if (sessionId.length    !== 32) throw new Error(`sessionId must be 32 bytes, got ${sessionId.length}`);
  if (responseHash.length !== 32) throw new Error(`responseHash must be 32 bytes, got ${responseHash.length}`);
  const msg = new Uint8Array(76);
  msg.set(sessionId, 0);
  writeU64LE(msg, runningTotal, 32);
  writeU32LE(msg, requestCount, 40);
  msg.set(responseHash, 44);
  return msg;
}

export function buildAckMessage(
  sessionId:    Uint8Array,
  runningTotal: bigint,
  requestCount: number,
): Uint8Array {
  if (sessionId.length !== 32) throw new Error(`sessionId must be 32 bytes, got ${sessionId.length}`);
  const msg = new Uint8Array(44);
  msg.set(sessionId, 0);
  writeU64LE(msg, runningTotal, 32);
  writeU32LE(msg, requestCount, 40);
  return msg;
}

export async function signMessageEd25519(
  identity: Identity,
  message:  Uint8Array,
): Promise<Uint8Array> {
  return signData(identity.privateKey, message);
}

export async function verifyMessageEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message:   Uint8Array,
): Promise<boolean> {
  return verifySignature(publicKey, signature, message);
}

/** @deprecated Use signSpendingAuth + EIP-712 instead. */
export async function signMessageEcdsa(
  signer:      AbstractSigner,
  messageHash: string,
): Promise<string> {
  return signer.signMessage(getBytes(messageHash));
}
