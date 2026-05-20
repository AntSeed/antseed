import type {
  VerificationCommitProofPayload,
  VerificationCommitRequestPayload,
  VerificationCommitResponsePayload,
  VerificationRevealAckPayload,
  VerificationRevealPackagePayload,
  VerificationRevealResponsePayload,
  VerificationUsageClaimPayload,
} from '../types/protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PAYLOAD_SIZE = 65536;

function parseJson(data: Uint8Array): Record<string, unknown> {
  if (data.byteLength > MAX_PAYLOAD_SIZE) {
    throw new Error(`Verification payload too large: ${data.byteLength} bytes (max ${MAX_PAYLOAD_SIZE})`);
  }
  const raw: unknown = JSON.parse(decoder.decode(data));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Expected JSON object');
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  if (typeof val !== 'string' || val.length === 0) throw new Error(`Missing or invalid string field: ${field}`);
  return val;
}

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  return typeof obj[field] === 'string' ? obj[field] : undefined;
}

function requireBool(obj: Record<string, unknown>, field: string): boolean {
  const val = obj[field];
  if (typeof val !== 'boolean') throw new Error(`Missing or invalid boolean field: ${field}`);
  return val;
}

function requireClaim(obj: Record<string, unknown>, field = 'claim'): VerificationUsageClaimPayload {
  const raw = obj[field];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`Missing or invalid claim field: ${field}`);
  const claim = raw as Record<string, unknown>;
  return {
    version: requireString(claim, 'version'),
    channelId: requireString(claim, 'channelId'),
    buyer: requireString(claim, 'buyer'),
    seller: requireString(claim, 'seller'),
    sellerAgentId: requireString(claim, 'sellerAgentId'),
    serviceKey: requireString(claim, 'serviceKey'),
    providerName: requireString(claim, 'providerName'),
    serviceName: requireString(claim, 'serviceName'),
    cumulativeInputTokens: requireString(claim, 'cumulativeInputTokens'),
    cumulativeCachedInputTokens: requireString(claim, 'cumulativeCachedInputTokens'),
    cumulativeFreshInputTokens: requireString(claim, 'cumulativeFreshInputTokens'),
    cumulativeOutputTokens: requireString(claim, 'cumulativeOutputTokens'),
    cumulativeRequestCount: requireString(claim, 'cumulativeRequestCount'),
    cumulativeCostUsdc: requireString(claim, 'cumulativeCostUsdc'),
    paymentCumulativeAmount: requireString(claim, 'paymentCumulativeAmount'),
  };
}

function encode(payload: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export const encodeVerificationCommitRequest = encode;
export const encodeVerificationCommitResponse = encode;
export const encodeVerificationCommitProof = encode;
export const encodeVerificationRevealPackage = encode;
export const encodeVerificationRevealResponse = encode;
export const encodeVerificationRevealAck = encode;

export function decodeVerificationCommitRequest(data: Uint8Array): VerificationCommitRequestPayload {
  const obj = parseJson(data);
  return {
    requestId: requireString(obj, 'requestId'),
    claim: requireClaim(obj),
    claimHash: requireString(obj, 'claimHash'),
    revealHash: requireString(obj, 'revealHash'),
    expectedEpoch: requireString(obj, 'expectedEpoch'),
    sellerSig: requireString(obj, 'sellerSig'),
  };
}

export function decodeVerificationCommitResponse(data: Uint8Array): VerificationCommitResponsePayload {
  const obj = parseJson(data);
  return {
    requestId: requireString(obj, 'requestId'),
    accepted: requireBool(obj, 'accepted'),
    claimHash: requireString(obj, 'claimHash'),
    revealHash: optionalString(obj, 'revealHash'),
    buyerSig: optionalString(obj, 'buyerSig'),
    reason: optionalString(obj, 'reason'),
  };
}

export function decodeVerificationCommitProof(data: Uint8Array): VerificationCommitProofPayload {
  const obj = parseJson(data);
  return {
    requestId: requireString(obj, 'requestId'),
    claimHash: requireString(obj, 'claimHash'),
    txHash: optionalString(obj, 'txHash'),
  };
}

export function decodeVerificationRevealPackage(data: Uint8Array): VerificationRevealPackagePayload {
  const obj = parseJson(data);
  const party = requireString(obj, 'party');
  if (party !== 'buyer' && party !== 'seller') throw new Error('Invalid reveal package party');
  return {
    requestId: requireString(obj, 'requestId'),
    claim: requireClaim(obj),
    claimHash: requireString(obj, 'claimHash'),
    nonce: requireString(obj, 'nonce'),
    party,
  };
}

export function decodeVerificationRevealResponse(data: Uint8Array): VerificationRevealResponsePayload {
  const obj = parseJson(data);
  return {
    requestId: requireString(obj, 'requestId'),
    accepted: requireBool(obj, 'accepted'),
    claimHash: requireString(obj, 'claimHash'),
    nonce: optionalString(obj, 'nonce'),
    reason: optionalString(obj, 'reason'),
  };
}

export function decodeVerificationRevealAck(data: Uint8Array): VerificationRevealAckPayload {
  const obj = parseJson(data);
  return {
    requestId: requireString(obj, 'requestId'),
    claimHash: requireString(obj, 'claimHash'),
    txHash: optionalString(obj, 'txHash'),
  };
}
