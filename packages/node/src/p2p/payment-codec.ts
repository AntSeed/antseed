import type {
  SpendingAuthPayload,
  AuthAckPayload,
  SellerReceiptPayload,
  BuyerAckPayload,
  TopUpRequestPayload,
} from '../types/protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

// SpendingAuth (0x50)

export function encodeSpendingAuth(payload: SpendingAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeSpendingAuth(data: Uint8Array): SpendingAuthPayload {
  const obj = parseJson(data);
  return {
    sessionId:     requireString(obj, 'sessionId'),
    maxAmountUsdc: requireString(obj, 'maxAmountUsdc'),
    nonce:         requireNumber(obj, 'nonce'),
    deadline:      requireNumber(obj, 'deadline'),
    buyerSig:      requireString(obj, 'buyerSig'),
  };
}

// AuthAck (0x51)

export function encodeAuthAck(payload: AuthAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeAuthAck(data: Uint8Array): AuthAckPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    nonce:     requireNumber(obj, 'nonce'),
  };
}

// SellerReceipt (0x53)

export function encodeSellerReceipt(payload: SellerReceiptPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeSellerReceipt(data: Uint8Array): SellerReceiptPayload {
  const obj = parseJson(data);
  return {
    sessionId:    requireString(obj, 'sessionId'),
    runningTotal: requireString(obj, 'runningTotal'),
    requestCount: requireNumber(obj, 'requestCount'),
    responseHash: requireString(obj, 'responseHash'),
    sellerSig:    requireString(obj, 'sellerSig'),
  };
}

// BuyerAck (0x54)

export function encodeBuyerAck(payload: BuyerAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeBuyerAck(data: Uint8Array): BuyerAckPayload {
  const obj = parseJson(data);
  return {
    sessionId:    requireString(obj, 'sessionId'),
    runningTotal: requireString(obj, 'runningTotal'),
    requestCount: requireNumber(obj, 'requestCount'),
    buyerSig:     requireString(obj, 'buyerSig'),
  };
}

// TopUpRequest (0x55)

export function encodeTopUpRequest(payload: TopUpRequestPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeTopUpRequest(data: Uint8Array): TopUpRequestPayload {
  const obj = parseJson(data);
  return {
    sessionId:           requireString(obj, 'sessionId'),
    currentUsed:         requireString(obj, 'currentUsed'),
    currentMax:          requireString(obj, 'currentMax'),
    requestedAdditional: requireString(obj, 'requestedAdditional'),
  };
}

