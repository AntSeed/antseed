import {
  PAYMENT_CODE_CHANNEL_EXHAUSTED,
  type SpendingAuthPayload,
  type AuthAckPayload,
  type FreeUsageOpenPayload,
  type FreeUsageAuthPayload,
  type FreeUsageAckPayload,
  type NeedFreeUsageAuthPayload,
  type PaymentRequiredPayload,
  type NeedAuthPayload,
} from '../types/protocol.js';
import { parseJsonObject, requireStringField } from '../utils/json-codec.js';

const encoder = new TextEncoder();

// --- Validation helpers ---

const MAX_PAYLOAD_SIZE = 65536; // 64KB

function parsePaymentJson(data: Uint8Array): Record<string, unknown> {
  return parseJsonObject(data, {
    maxBytes: MAX_PAYLOAD_SIZE,
    payloadName: 'Payment payload',
  });
}

function requireFiniteNumberField(obj: Record<string, unknown>, field: string): number {
  const value = typeof obj[field] === 'number' ? obj[field] : Number(requireStringField(obj, field));
  if (!Number.isFinite(value)) {
    throw new Error(`Payment payload field "${field}" must be a finite number`);
  }
  return value;
}

// --- Encoders ---

export function encodeSpendingAuth(payload: SpendingAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeAuthAck(payload: AuthAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeFreeUsageOpen(payload: FreeUsageOpenPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeFreeUsageAuth(payload: FreeUsageAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeFreeUsageAck(payload: FreeUsageAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeNeedFreeUsageAuth(payload: NeedFreeUsageAuthPayload): Uint8Array {
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
  const obj = parsePaymentJson(data);
  const result: SpendingAuthPayload = {
    channelId: requireStringField(obj, 'channelId'),
    cumulativeAmount: requireStringField(obj, 'cumulativeAmount'),
    metadataHash: requireStringField(obj, 'metadataHash'),
    metadata: typeof obj.metadata === 'string' ? obj.metadata : '',
    spendingAuthSig: requireStringField(obj, 'spendingAuthSig'),
  };
  // Optional reserve params (only on initial auth)
  if (typeof obj.reserveSalt === 'string') result.reserveSalt = obj.reserveSalt;
  if (typeof obj.reserveMaxAmount === 'string') result.reserveMaxAmount = obj.reserveMaxAmount;
  if (typeof obj.reserveDeadline === 'number') result.reserveDeadline = obj.reserveDeadline;
  return result;
}

export function decodeAuthAck(data: Uint8Array): AuthAckPayload {
  const obj = parsePaymentJson(data);
  return {
    channelId: requireStringField(obj, 'channelId'),
  };
}

export function decodeFreeUsageOpen(data: Uint8Array): FreeUsageOpenPayload {
  const obj = parsePaymentJson(data);
  return {
    channelId: requireStringField(obj, 'channelId'),
    salt: requireStringField(obj, 'salt'),
    deadline: requireFiniteNumberField(obj, 'deadline'),
    openSig: requireStringField(obj, 'openSig'),
  };
}

export function decodeFreeUsageAuth(data: Uint8Array): FreeUsageAuthPayload {
  const obj = parsePaymentJson(data);
  return {
    channelId: requireStringField(obj, 'channelId'),
    cumulativeInputTokens: requireStringField(obj, 'cumulativeInputTokens'),
    cumulativeOutputTokens: requireStringField(obj, 'cumulativeOutputTokens'),
    sequence: requireStringField(obj, 'sequence'),
    metadataHash: requireStringField(obj, 'metadataHash'),
    metadata: requireStringField(obj, 'metadata'),
    deadline: requireFiniteNumberField(obj, 'deadline'),
    usageSig: requireStringField(obj, 'usageSig'),
  };
}

export function decodeFreeUsageAck(data: Uint8Array): FreeUsageAckPayload {
  const obj = parsePaymentJson(data);
  const result: FreeUsageAckPayload = {
    channelId: requireStringField(obj, 'channelId'),
  };
  if (typeof obj.acceptedSequence === 'string') result.acceptedSequence = obj.acceptedSequence;
  return result;
}

export function decodeNeedFreeUsageAuth(data: Uint8Array): NeedFreeUsageAuthPayload {
  const obj = parsePaymentJson(data);
  const result: NeedFreeUsageAuthPayload = {
    channelId: requireStringField(obj, 'channelId'),
    requiredSequence: requireStringField(obj, 'requiredSequence'),
    currentAcceptedSequence: requireStringField(obj, 'currentAcceptedSequence'),
  };
  if (typeof obj.requestId === 'string') result.requestId = obj.requestId;
  if (typeof obj.inputTokens === 'string') result.inputTokens = obj.inputTokens;
  if (typeof obj.outputTokens === 'string') result.outputTokens = obj.outputTokens;
  if (typeof obj.service === 'string') result.service = obj.service;
  return result;
}

export function decodePaymentRequired(data: Uint8Array): PaymentRequiredPayload {
  const obj = parsePaymentJson(data);
  const result: PaymentRequiredPayload = {
    minBudgetPerRequest: requireStringField(obj, 'minBudgetPerRequest'),
    suggestedAmount: requireStringField(obj, 'suggestedAmount'),
    requestId: requireStringField(obj, 'requestId'),
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
  const obj = parsePaymentJson(data);
  const result: NeedAuthPayload = {
    channelId: requireStringField(obj, 'channelId'),
    requiredCumulativeAmount: requireStringField(obj, 'requiredCumulativeAmount'),
    currentAcceptedCumulative: requireStringField(obj, 'currentAcceptedCumulative'),
    deposit: requireStringField(obj, 'deposit'),
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
