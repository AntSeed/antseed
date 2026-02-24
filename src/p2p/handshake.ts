import { type PeerId, toPeerId } from "../types/peer.js";
import { MessageType } from "../types/protocol.js";
import { ConnectionState } from "../types/connection.js";
import { signData, verifySignature, bytesToHex } from "./identity.js";
import type { PeerConnection } from "./connection-manager.js";

/** Nonce size in bytes. */
const NONCE_SIZE = 32;

/** Handshake timeout in milliseconds. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface HandshakeResult {
  remotePeerId: PeerId;
  verified: boolean;
}

/** Generate a random nonce for the handshake challenge. */
function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_SIZE);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Build the HandshakeInit payload:
 *   [32 bytes pubkey] [32 bytes nonce] [64 bytes signature(nonce)]
 */
export async function buildHandshakeInit(
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Promise<{ payload: Uint8Array; nonce: Uint8Array }> {
  const nonce = generateNonce();
  const signature = await signData(privateKey, nonce);

  const payload = new Uint8Array(32 + 32 + 64);
  payload.set(publicKey, 0);
  payload.set(nonce, 32);
  payload.set(signature, 64);

  return { payload, nonce };
}

/**
 * Verify a received HandshakeInit payload.
 * Returns the remote peer's public key and nonce if valid.
 */
export async function verifyHandshakeInit(
  payload: Uint8Array
): Promise<{ remotePubKey: Uint8Array; nonce: Uint8Array; valid: boolean }> {
  if (payload.length !== 128) {
    return { remotePubKey: new Uint8Array(32), nonce: new Uint8Array(32), valid: false };
  }

  const remotePubKey = payload.slice(0, 32);
  const nonce = payload.slice(32, 64);
  const signature = payload.slice(64, 128);

  const valid = await verifySignature(remotePubKey, signature, nonce);

  return { remotePubKey, nonce, valid };
}

/**
 * Build a HandshakeAck payload:
 *   [32 bytes pubkey] [32 bytes echo-nonce] [64 bytes signature(echo-nonce)]
 */
export async function buildHandshakeAck(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  remoteNonce: Uint8Array
): Promise<Uint8Array> {
  const signature = await signData(privateKey, remoteNonce);

  const payload = new Uint8Array(32 + 32 + 64);
  payload.set(publicKey, 0);
  payload.set(remoteNonce, 32);
  payload.set(signature, 64);

  return payload;
}

/**
 * Verify a received HandshakeAck payload against the nonce we originally sent.
 */
export async function verifyHandshakeAck(
  payload: Uint8Array,
  originalNonce: Uint8Array
): Promise<{ remotePubKey: Uint8Array; valid: boolean }> {
  if (payload.length !== 128) {
    return { remotePubKey: new Uint8Array(32), valid: false };
  }

  const remotePubKey = payload.slice(0, 32);
  const echoNonce = payload.slice(32, 64);
  const signature = payload.slice(64, 128);

  // Verify that the echoed nonce matches what we sent
  const nonceMatches = originalNonce.every((b, i) => b === echoNonce[i]);
  if (!nonceMatches) {
    return { remotePubKey, valid: false };
  }

  const valid = await verifySignature(remotePubKey, signature, echoNonce);
  return { remotePubKey, valid };
}

/**
 * Perform the full handshake as the initiator.
 * Sends HandshakeInit, waits for HandshakeAck, verifies.
 */
export async function performHandshake(
  conn: PeerConnection,
  localPublicKey: Uint8Array,
  localPrivateKey: Uint8Array,
  sendFn: (type: MessageType, payload: Uint8Array) => void,
  waitForMessage: (type: MessageType, timeoutMs: number) => Promise<Uint8Array>
): Promise<HandshakeResult> {
  const { payload, nonce } = await buildHandshakeInit(localPublicKey, localPrivateKey);
  sendFn(MessageType.HandshakeInit, payload);

  const ackPayload = await waitForMessage(MessageType.HandshakeAck, HANDSHAKE_TIMEOUT_MS);
  const { remotePubKey, valid } = await verifyHandshakeAck(ackPayload, nonce);

  const remotePeerId = toPeerId(bytesToHex(remotePubKey));

  if (valid) {
    conn.setState(ConnectionState.Authenticated);
  } else {
    conn.setState(ConnectionState.Failed);
  }

  return { remotePeerId, verified: valid };
}

/**
 * Respond to a handshake as the responder.
 * Waits for HandshakeInit, verifies, sends HandshakeAck.
 */
export async function respondToHandshake(
  conn: PeerConnection,
  localPublicKey: Uint8Array,
  localPrivateKey: Uint8Array,
  sendFn: (type: MessageType, payload: Uint8Array) => void,
  waitForMessage: (type: MessageType, timeoutMs: number) => Promise<Uint8Array>
): Promise<HandshakeResult> {
  const initPayload = await waitForMessage(MessageType.HandshakeInit, HANDSHAKE_TIMEOUT_MS);
  const { remotePubKey, nonce, valid } = await verifyHandshakeInit(initPayload);

  if (!valid) {
    conn.setState(ConnectionState.Failed);
    return { remotePeerId: toPeerId(bytesToHex(remotePubKey)), verified: false };
  }

  const ackPayload = await buildHandshakeAck(localPublicKey, localPrivateKey, nonce);
  sendFn(MessageType.HandshakeAck, ackPayload);

  const remotePeerId = toPeerId(bytesToHex(remotePubKey));
  conn.setState(ConnectionState.Authenticated);

  return { remotePeerId, verified: true };
}
