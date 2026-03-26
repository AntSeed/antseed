import type {
  SpendingAuthPayload,
  AuthAckPayload,
  PaymentRequiredPayload,
  NeedAuthPayload,
} from '../types/protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Validation helpers ---

const MAX_PAYLOAD_SIZE = 65536; // 64KB

function parseJson(data: Uint8Array): Record<string, unknown> {
  if (data.byteLength > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payment payload too large: ${data.byteLength} bytes (max ${MAX_PAYLOAD_SIZE})`);
  }
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

export function encodePaymentRequired(payload: PaymentRequiredPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeNeedAuth(payload: NeedAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

// --- Decoders (with runtime validation) ---

export function decodeSpendingAuth(data: Uint8Array): SpendingAuthPayload {
  const obj = parseJson(data);
  const result: SpendingAuthPayload = {
    sessionId: requireString(obj, 'sessionId'),
    cumulativeAmount: requireString(obj, 'cumulativeAmount'),
    metadataHash: requireString(obj, 'metadataHash'),
    metadata: requireString(obj, 'metadata'),
    buyerSig: requireString(obj, 'buyerSig'),
    buyerEvmAddr: requireString(obj, 'buyerEvmAddr'),
  };
  // Optional reserve params (only on initial auth)
  if (typeof obj.reserveAmount === 'string') result.reserveAmount = obj.reserveAmount;
  if (typeof obj.reserveNonce === 'number') result.reserveNonce = obj.reserveNonce;
  if (typeof obj.reserveDeadline === 'number') result.reserveDeadline = obj.reserveDeadline;
  return result;
}

export function decodeAuthAck(data: Uint8Array): AuthAckPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    nonce: requireNumber(obj, 'nonce'),
  };
}

export function decodePaymentRequired(data: Uint8Array): PaymentRequiredPayload {
  const obj = parseJson(data);
  const result: PaymentRequiredPayload = {
    sellerEvmAddr: requireString(obj, 'sellerEvmAddr'),
    minBudgetPerRequest: requireString(obj, 'minBudgetPerRequest'),
    suggestedAmount: requireString(obj, 'suggestedAmount'),
    requestId: requireString(obj, 'requestId'),
  };
  if (typeof obj.inputUsdPerMillion === 'number') result.inputUsdPerMillion = obj.inputUsdPerMillion;
  if (typeof obj.outputUsdPerMillion === 'number') result.outputUsdPerMillion = obj.outputUsdPerMillion;
  return result;
}

export function decodeNeedAuth(data: Uint8Array): NeedAuthPayload {
  const obj = parseJson(data);
  return {
    sessionId: requireString(obj, 'sessionId'),
    requiredCumulativeAmount: requireString(obj, 'requiredCumulativeAmount'),
    currentAcceptedCumulative: requireString(obj, 'currentAcceptedCumulative'),
    deposit: requireString(obj, 'deposit'),
  };
}
