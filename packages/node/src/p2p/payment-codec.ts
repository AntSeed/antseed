import {
  PAYMENT_CODE_CHANNEL_EXHAUSTED,
  type SpendingAuthPayload,
  type AuthAckPayload,
  type PaymentRequiredPayload,
  type NeedAuthPayload,
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
    channelId: requireString(obj, 'channelId'),
    cumulativeAmount: requireString(obj, 'cumulativeAmount'),
    metadataHash: requireString(obj, 'metadataHash'),
    metadata: typeof obj.metadata === 'string' ? obj.metadata : '',
    spendingAuthSig: requireString(obj, 'spendingAuthSig'),
  };
  // Optional reserve params (only on initial auth)
  if (typeof obj.reserveSalt === 'string') result.reserveSalt = obj.reserveSalt;
  if (typeof obj.reserveMaxAmount === 'string') result.reserveMaxAmount = obj.reserveMaxAmount;
  if (typeof obj.reserveDeadline === 'number') result.reserveDeadline = obj.reserveDeadline;
  return result;
}

export function decodeAuthAck(data: Uint8Array): AuthAckPayload {
  const obj = parseJson(data);
  return {
    channelId: requireString(obj, 'channelId'),
  };
}

export function decodePaymentRequired(data: Uint8Array): PaymentRequiredPayload {
  const obj = parseJson(data);
  const result: PaymentRequiredPayload = {
    minBudgetPerRequest: requireString(obj, 'minBudgetPerRequest'),
    suggestedAmount: requireString(obj, 'suggestedAmount'),
    requestId: requireString(obj, 'requestId'),
  };
  if (typeof obj.inputUsdPerMillion === 'number') result.inputUsdPerMillion = obj.inputUsdPerMillion;
  if (typeof obj.outputUsdPerMillion === 'number') result.outputUsdPerMillion = obj.outputUsdPerMillion;
  if (typeof obj.cachedInputUsdPerMillion === 'number') result.cachedInputUsdPerMillion = obj.cachedInputUsdPerMillion;
  if (typeof obj.requiredCumulativeAmount === 'string') result.requiredCumulativeAmount = obj.requiredCumulativeAmount;
  if (typeof obj.currentSpent === 'string') result.currentSpent = obj.currentSpent;
  if (typeof obj.currentAcceptedCumulative === 'string') result.currentAcceptedCumulative = obj.currentAcceptedCumulative;
  if (typeof obj.channelId === 'string') result.channelId = obj.channelId;
  if (typeof obj.reserveMaxAmount === 'string') result.reserveMaxAmount = obj.reserveMaxAmount;
  if (obj.code === PAYMENT_CODE_CHANNEL_EXHAUSTED) result.code = obj.code;
  return result;
}

export function decodeNeedAuth(data: Uint8Array): NeedAuthPayload {
  const obj = parseJson(data);
  const result: NeedAuthPayload = {
    channelId: requireString(obj, 'channelId'),
    requiredCumulativeAmount: requireString(obj, 'requiredCumulativeAmount'),
    currentAcceptedCumulative: requireString(obj, 'currentAcceptedCumulative'),
    deposit: requireString(obj, 'deposit'),
  };
  if (typeof obj.requestId === 'string') result.requestId = obj.requestId;
  if (typeof obj.lastRequestCost === 'string') result.lastRequestCost = obj.lastRequestCost;
  if (typeof obj.inputTokens === 'string') result.inputTokens = obj.inputTokens;
  if (typeof obj.outputTokens === 'string') result.outputTokens = obj.outputTokens;
  if (typeof obj.cachedInputTokens === 'string') result.cachedInputTokens = obj.cachedInputTokens;
  if (typeof obj.freshInputTokens === 'string') result.freshInputTokens = obj.freshInputTokens;
  if (typeof obj.service === 'string') result.service = obj.service;
  return result;
}
