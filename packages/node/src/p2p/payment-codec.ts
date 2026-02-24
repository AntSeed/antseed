import type {
  SessionLockAuthPayload,
  SessionLockConfirmPayload,
  SessionLockRejectPayload,
  SellerReceiptPayload,
  BuyerAckPayload,
  SessionEndPayload,
  TopUpRequestPayload,
  TopUpAuthPayload,
  DisputeNotifyPayload,
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

export function encodeSessionLockAuth(payload: SessionLockAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeSessionLockConfirm(payload: SessionLockConfirmPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeSessionLockReject(payload: SessionLockRejectPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeSellerReceipt(payload: SellerReceiptPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeBuyerAck(payload: BuyerAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeSessionEnd(payload: SessionEndPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeTopUpRequest(payload: TopUpRequestPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeTopUpAuth(payload: TopUpAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeDisputeNotify(payload: DisputeNotifyPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

// --- Decoders (with runtime validation) ---

export function decodeSessionLockAuth(data: Uint8Array): SessionLockAuthPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    lockedAmount: requireString(obj, 'lockedAmount'),
    buyerSig: requireString(obj, 'buyerSig'),
  };
}

export function decodeSessionLockConfirm(data: Uint8Array): SessionLockConfirmPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    txSignature: requireString(obj, 'txSignature'),
  };
}

export function decodeSessionLockReject(data: Uint8Array): SessionLockRejectPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    reason: requireString(obj, 'reason'),
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

export function decodeSessionEnd(data: Uint8Array): SessionEndPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    runningTotal: requireString(obj, 'runningTotal'),
    requestCount: requireNumber(obj, 'requestCount'),
    score: requireNumber(obj, 'score'),
    buyerSig: requireString(obj, 'buyerSig'),
  };
}

export function decodeTopUpRequest(data: Uint8Array): TopUpRequestPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    additionalAmount: requireString(obj, 'additionalAmount'),
    currentRunningTotal: requireString(obj, 'currentRunningTotal'),
    currentLockedAmount: requireString(obj, 'currentLockedAmount'),
  };
}

export function decodeTopUpAuth(data: Uint8Array): TopUpAuthPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    additionalAmount: requireString(obj, 'additionalAmount'),
    buyerSig: requireString(obj, 'buyerSig'),
  };
}

export function decodeDisputeNotify(data: Uint8Array): DisputeNotifyPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    reason: requireString(obj, 'reason'),
    txSignature: requireString(obj, 'txSignature'),
  };
}
