import type {
  SpendingAuthPayload,
  AuthAckPayload,
  SellerReceiptPayload,
  BuyerAckPayload,
  TopUpRequestPayload,
} from '../types/protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Validation helpers ---

function parseJson(data: Uint8Array): Record<string, unknown> {
  const raw: unknown = JSON.parse(decoder.decode(data));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Missing or invalid string field: ${field}`);
  }
  return val;
}

function requireNumber(obj: Record<string, unknown>, field: string): number {
  const val = obj[field];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`Missing or invalid number field: ${field}`);
  }
  return val;
}

// --- Encoders ---

export function encodeSpendingAuth(payload: SpendingAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeAuthAck(payload: AuthAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeSellerReceipt(payload: SellerReceiptPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeBuyerAck(payload: BuyerAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeTopUpRequest(payload: TopUpRequestPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

// --- Decoders (with runtime validation) ---

export function decodeSpendingAuth(data: Uint8Array): SpendingAuthPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    maxAmountUsdc: requireString(obj, 'maxAmountUsdc'),
    nonce: requireNumber(obj, 'nonce'),
    deadline: requireNumber(obj, 'deadline'),
    buyerSig: requireString(obj, 'buyerSig'),
    buyerEvmAddr: requireString(obj, 'buyerEvmAddr'),
    previousConsumption: requireString(obj, 'previousConsumption'),
    previousSessionId: requireString(obj, 'previousSessionId'),
  };
}

export function decodeAuthAck(data: Uint8Array): AuthAckPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    nonce: requireNumber(obj, 'nonce'),
  };
}

export function decodeSellerReceipt(data: Uint8Array): SellerReceiptPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    runningTotal: requireString(obj, 'runningTotal'),
    requestCount: requireNumber(obj, 'requestCount'),
    responseHash: requireString(obj, 'responseHash'),
    sellerSig: requireString(obj, 'sellerSig'),
  };
}

export function decodeBuyerAck(data: Uint8Array): BuyerAckPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    runningTotal: requireString(obj, 'runningTotal'),
    requestCount: requireNumber(obj, 'requestCount'),
    buyerSig: requireString(obj, 'buyerSig'),
  };
}

export function decodeTopUpRequest(data: Uint8Array): TopUpRequestPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    currentUsed: requireString(obj, 'currentUsed'),
    currentMax: requireString(obj, 'currentMax'),
    requestedAdditional: requireString(obj, 'requestedAdditional'),
  };
}
