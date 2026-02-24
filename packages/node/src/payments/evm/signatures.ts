import { type AbstractSigner, solidityPackedKeccak256, getBytes } from 'ethers';
import type { Identity } from '../../p2p/identity.js';
import { signData, verifySignature } from '../../p2p/identity.js';

// =========================================================================
// ECDSA signatures (on-chain) — verified by contract via ecrecover
// =========================================================================

export function buildLockMessageHash(
  sessionId: string,
  seller: string,
  amount: bigint,
): string {
  return solidityPackedKeccak256(
    ['bytes1', 'bytes32', 'address', 'uint256'],
    ['0x01', sessionId, seller, amount],
  );
}

export function buildSettlementMessageHash(
  sessionId: string,
  runningTotal: bigint,
  score: number,
): string {
  return solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint8'],
    [sessionId, runningTotal, score],
  );
}

export function buildExtendLockMessageHash(
  sessionId: string,
  seller: string,
  additionalAmount: bigint,
): string {
  return solidityPackedKeccak256(
    ['bytes1', 'bytes32', 'address', 'uint256'],
    ['0x02', sessionId, seller, additionalAmount],
  );
}

export async function signMessageEcdsa(
  signer: AbstractSigner,
  messageHash: string,
): Promise<string> {
  return signer.signMessage(getBytes(messageHash));
}

// =========================================================================
// Ed25519 signatures (off-chain P2P) — bilateral receipt proof
// =========================================================================

export function buildReceiptMessage(
  sessionId: Uint8Array,
  runningTotal: bigint,
  requestCount: number,
  responseHash: Uint8Array,
): Uint8Array {
  if (sessionId.length !== 32) throw new Error(`sessionId must be 32 bytes, got ${sessionId.length}`);
  if (responseHash.length !== 32) throw new Error(`responseHash must be 32 bytes, got ${responseHash.length}`);
  const msg = new Uint8Array(76);
  msg.set(sessionId, 0);
  const totalBuf = new ArrayBuffer(8);
  new DataView(totalBuf).setBigUint64(0, runningTotal, true);
  msg.set(new Uint8Array(totalBuf), 32);
  const countBuf = new ArrayBuffer(4);
  new DataView(countBuf).setUint32(0, requestCount, true);
  msg.set(new Uint8Array(countBuf), 40);
  msg.set(responseHash, 44);
  return msg;
}

export function buildAckMessage(
  sessionId: Uint8Array,
  runningTotal: bigint,
  requestCount: number,
): Uint8Array {
  if (sessionId.length !== 32) throw new Error(`sessionId must be 32 bytes, got ${sessionId.length}`);
  const msg = new Uint8Array(44);
  msg.set(sessionId, 0);
  const totalBuf = new ArrayBuffer(8);
  new DataView(totalBuf).setBigUint64(0, runningTotal, true);
  msg.set(new Uint8Array(totalBuf), 32);
  const countBuf = new ArrayBuffer(4);
  new DataView(countBuf).setUint32(0, requestCount, true);
  msg.set(new Uint8Array(countBuf), 40);
  return msg;
}

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
