import type { SweepRequestPayload, SweepReceiptPayload, SweepReceiptStatus } from '../types/protocol.js';
import { parseJsonObject, requireStringField, requireFiniteNumberField } from '../utils/json-codec.js';

const encoder = new TextEncoder();

// Sweep payloads are small and fixed-shape; cap well below the payment codec.
const MAX_PAYLOAD_SIZE = 8192; // 8KB

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/; // 65-byte r||s||v
const UINT256_DECIMAL_RE = /^[0-9]{1,78}$/;

const RECEIPT_STATUSES: readonly SweepReceiptStatus[] = ['submitted', 'confirmed', 'rejected'];

function parseSweepJson(data: Uint8Array): Record<string, unknown> {
  return parseJsonObject(data, {
    maxBytes: MAX_PAYLOAD_SIZE,
    payloadName: 'Sweep payload',
  });
}

function requirePatternField(obj: Record<string, unknown>, field: string, re: RegExp, kind: string): string {
  const value = requireStringField(obj, field);
  if (!re.test(value)) {
    throw new Error(`Sweep payload field "${field}" is not a valid ${kind}`);
  }
  return value;
}

// --- Encoders ---

export function encodeSweepRequest(payload: SweepRequestPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeSweepReceipt(payload: SweepReceiptPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

// --- Decoders (with runtime validation — payloads are untrusted peer input) ---

export function decodeSweepRequest(data: Uint8Array): SweepRequestPayload {
  const obj = parseSweepJson(data);
  if (obj.version !== 1) {
    throw new Error('Unsupported sweep request version');
  }
  const validAfter = requireFiniteNumberField(obj, 'validAfter');
  const validBefore = requireFiniteNumberField(obj, 'validBefore');
  if (validAfter < 0 || validBefore <= 0) {
    throw new Error('Sweep payload validity window out of range');
  }
  return {
    version: 1,
    evmChainId: requireFiniteNumberField(obj, 'evmChainId'),
    relayAddress: requirePatternField(obj, 'relayAddress', ADDRESS_RE, 'address'),
    from: requirePatternField(obj, 'from', ADDRESS_RE, 'address'),
    amount: requirePatternField(obj, 'amount', UINT256_DECIMAL_RE, 'uint256 decimal string'),
    validAfter,
    validBefore,
    nonce: requirePatternField(obj, 'nonce', BYTES32_RE, 'bytes32'),
    sig3009: requirePatternField(obj, 'sig3009', SIGNATURE_RE, 'signature'),
  };
}

export function decodeSweepReceipt(data: Uint8Array): SweepReceiptPayload {
  const obj = parseSweepJson(data);
  if (obj.version !== 1) {
    throw new Error('Unsupported sweep receipt version');
  }
  const status = requireStringField(obj, 'status') as SweepReceiptStatus;
  if (!RECEIPT_STATUSES.includes(status)) {
    throw new Error(`Sweep receipt status must be one of: ${RECEIPT_STATUSES.join(', ')}`);
  }
  const result: SweepReceiptPayload = {
    version: 1,
    authNonce: requirePatternField(obj, 'authNonce', BYTES32_RE, 'bytes32'),
    status,
  };
  if (typeof obj.txHash === 'string' && BYTES32_RE.test(obj.txHash)) result.txHash = obj.txHash;
  if (typeof obj.reason === 'string' && obj.reason.length <= 256) result.reason = obj.reason;
  return result;
}
