import { keccak256 } from 'ethers';
import type { Wallet } from 'ethers';
import type { ResponseAuthPayload } from '../types/protocol.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '../types/http.js';
import { bytesToHex, hexToBytes, signData, verifySignature } from '../p2p/identity.js';
import { encodeHttpRequest, encodeHttpResponse } from '../proxy/request-codec.js';
import type { StoredResponseAuth } from './storage.js';

const RESPONSE_AUTH_DOMAIN = 'antseed-response-auth-v1';

export interface ResponseAuthInput {
  request: SerializedHttpRequest;
  response: SerializedHttpResponse;
  buyerPeerId: string;
  sellerPeerId: string;
  advertisedService: string;
  provider: string;
  responseStartedAt: number;
  responseCompletedAt: number;
  channelId?: string | null;
}

export interface ResponseAuthVerificationExpected {
  request: SerializedHttpRequest;
  response: SerializedHttpResponse;
  buyerPeerId: string;
  sellerPeerId: string;
  advertisedService: string;
  channelId?: string | null;
}

export interface ResponseAuthVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface ResponseAuthExecutionWindow {
  responseStartedAt: number;
  responseCompletedAt: number;
}

export function createResponseAuthPayload(input: ResponseAuthInput, signer: Wallet): ResponseAuthPayload {
  const payload: Omit<ResponseAuthPayload, 'signature'> = {
    version: 1,
    requestId: input.request.requestId,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    buyerPeerId: normalizePeerId(input.buyerPeerId),
    sellerPeerId: normalizePeerId(input.sellerPeerId),
    advertisedService: input.advertisedService,
    provider: input.provider,
    statusCode: input.response.statusCode,
    requestHash: hashRequest(input.request),
    responseHash: hashResponse(input.response),
    responseStartedAt: input.responseStartedAt,
    responseCompletedAt: input.responseCompletedAt,
  };
  const signature = bytesToHex(signData(signer, buildResponseAuthSigningBytes(payload)));
  return { ...payload, signature };
}

/**
 * Strip local bookkeeping (receivedAt/verified/verificationError) from a
 * stored record so only the seller-signed payload remains. Kept next to the
 * payload type: a new ResponseAuth field added here cannot be silently
 * dropped by an app-layer copy.
 */
export function toResponseAuthPayload(stored: StoredResponseAuth): ResponseAuthPayload {
  return {
    version: stored.version,
    requestId: stored.requestId,
    ...(stored.channelId ? { channelId: stored.channelId } : {}),
    buyerPeerId: stored.buyerPeerId,
    sellerPeerId: stored.sellerPeerId,
    advertisedService: stored.advertisedService,
    provider: stored.provider,
    statusCode: stored.statusCode,
    requestHash: stored.requestHash,
    responseHash: stored.responseHash,
    responseStartedAt: stored.responseStartedAt,
    responseCompletedAt: stored.responseCompletedAt,
    signature: stored.signature,
  };
}

export function verifyResponseAuth(
  payload: ResponseAuthPayload,
  expected: ResponseAuthVerificationExpected,
): ResponseAuthVerificationResult {
  const expectedRequestHash = hashRequest(expected.request);
  if (payload.requestHash !== expectedRequestHash) {
    return { valid: false, reason: 'request_hash_mismatch' };
  }

  const expectedResponseHash = hashResponse(expected.response);
  if (payload.responseHash !== expectedResponseHash) {
    return { valid: false, reason: 'response_hash_mismatch' };
  }

  if (payload.requestId !== expected.request.requestId) {
    return { valid: false, reason: 'request_id_mismatch' };
  }
  if (payload.statusCode !== expected.response.statusCode) {
    return { valid: false, reason: 'status_code_mismatch' };
  }
  if (normalizePeerId(payload.buyerPeerId) !== normalizePeerId(expected.buyerPeerId)) {
    return { valid: false, reason: 'buyer_peer_mismatch' };
  }
  if (normalizePeerId(payload.sellerPeerId) !== normalizePeerId(expected.sellerPeerId)) {
    return { valid: false, reason: 'seller_peer_mismatch' };
  }
  if (payload.advertisedService !== expected.advertisedService) {
    return { valid: false, reason: 'advertised_service_mismatch' };
  }
  if (expected.channelId && payload.channelId !== expected.channelId) {
    return { valid: false, reason: 'channel_id_mismatch' };
  }

  const { signature: _signature, ...unsigned } = payload;
  let validSignature = false;
  try {
    const signature = hexToBytes(payload.signature);
    validSignature = verifySignature(
      normalizePeerId(expected.sellerPeerId),
      signature,
      buildResponseAuthSigningBytes(unsigned),
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
}

export function verifyResponseAuthExecutionWindow(
  payload: ResponseAuthExecutionWindow,
  executeAfterSeconds: number,
  executeBeforeSeconds: number,
): ResponseAuthVerificationResult {
  if (![payload.responseStartedAt, payload.responseCompletedAt, executeAfterSeconds, executeBeforeSeconds]
    .every(Number.isSafeInteger)) {
    return { valid: false, reason: 'invalid_execution_timestamp' };
  }
  if (executeBeforeSeconds <= executeAfterSeconds) {
    return { valid: false, reason: 'invalid_execution_window' };
  }
  if (payload.responseCompletedAt < payload.responseStartedAt) {
    return { valid: false, reason: 'response_time_reversed' };
  }
  if (payload.responseStartedAt < executeAfterSeconds * 1_000) {
    return { valid: false, reason: 'response_started_before_window' };
  }
  if (payload.responseCompletedAt > executeBeforeSeconds * 1_000) {
    return { valid: false, reason: 'response_completed_after_window' };
  }
  return { valid: true };
}

export function hashRequest(request: SerializedHttpRequest): string {
  return keccak256(encodeHttpRequest(request));
}

export function hashResponse(response: SerializedHttpResponse): string {
  return keccak256(encodeHttpResponse(stripStreamingHeader(response)));
}

export function buildResponseAuthSigningBytes(payload: Omit<ResponseAuthPayload, 'signature'>): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [
    RESPONSE_AUTH_DOMAIN,
    String(payload.version),
    payload.requestId,
    payload.channelId ?? '',
    normalizePeerId(payload.buyerPeerId),
    normalizePeerId(payload.sellerPeerId),
    payload.advertisedService,
    payload.provider,
    String(payload.statusCode),
    payload.requestHash,
    payload.responseHash,
    String(payload.responseStartedAt),
    String(payload.responseCompletedAt),
  ].map((field) => encoder.encode(field));

  const totalLength = fields.reduce((sum, field) => sum + 4 + field.length, 0);
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length);
    offset += 4;
    out.set(field, offset);
    offset += field.length;
  }
  return out;
}

export function encodeContractResponseAuthPayload(payload: ResponseAuthPayload): Uint8Array {
  const { signature, ...unsigned } = payload;
  const signingBytes = buildResponseAuthSigningBytes(unsigned);
  const signatureBytes = hexToBytes(signature);
  if (signatureBytes.length !== 65) throw new Error('ResponseAuth signature must be 65 bytes');
  const output = new Uint8Array(signingBytes.length + signatureBytes.length);
  output.set(signingBytes, 0);
  output.set(signatureBytes, signingBytes.length);
  return output;
}

export function extractContractResponseAuthSigningPayload(payload: Uint8Array): Uint8Array {
  if (payload.length <= 65) throw new Error('Contract ResponseAuth payload is too short');
  return payload.subarray(0, payload.length - 65);
}

export function decodeContractResponseAuthPayload(payload: Uint8Array): ResponseAuthPayload {
  const signingBytes = extractContractResponseAuthSigningPayload(payload);
  const signature = bytesToHex(payload.subarray(payload.length - 65));
  const decoder = new TextDecoder();
  const view = new DataView(signingBytes.buffer, signingBytes.byteOffset, signingBytes.byteLength);
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < 13; index += 1) {
    if (offset + 4 > signingBytes.length) throw new Error('Malformed ResponseAuth signing payload');
    const length = view.getUint32(offset);
    offset += 4;
    if (offset + length > signingBytes.length) throw new Error('Malformed ResponseAuth signing payload');
    fields.push(decoder.decode(signingBytes.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset !== signingBytes.length) throw new Error('ResponseAuth signing payload has trailing bytes');
  if (fields[0] !== RESPONSE_AUTH_DOMAIN || fields[1] !== '1') throw new Error('ResponseAuth signing domain mismatch');
  const statusCode = Number(fields[8]);
  const responseStartedAt = Number(fields[11]);
  const responseCompletedAt = Number(fields[12]);
  if (![statusCode, responseStartedAt, responseCompletedAt].every(Number.isSafeInteger)) {
    throw new Error('ResponseAuth numeric field is invalid');
  }
  return {
    version: 1,
    requestId: fields[2]!,
    ...(fields[3] ? { channelId: fields[3] } : {}),
    buyerPeerId: fields[4]!,
    sellerPeerId: fields[5]!,
    advertisedService: fields[6]!,
    provider: fields[7]!,
    statusCode,
    requestHash: fields[9]!,
    responseHash: fields[10]!,
    responseStartedAt,
    responseCompletedAt,
    signature,
  };
}

function stripStreamingHeader(response: SerializedHttpResponse): SerializedHttpResponse {
  if (response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] !== '1') {
    return response;
  }
  const headers = { ...response.headers };
  delete headers[ANTSEED_STREAMING_RESPONSE_HEADER];
  return { ...response, headers };
}

function normalizePeerId(peerId: string): string {
  return peerId.startsWith('0x') ? peerId.slice(2).toLowerCase() : peerId.toLowerCase();
}
