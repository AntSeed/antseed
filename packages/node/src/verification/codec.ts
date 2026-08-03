import type { ResponseAuthPayload } from '../types/protocol.js';
import {
  parseJsonObject,
  requireFiniteNumberField,
  requireStringField,
} from '../utils/json-codec.js';

const encoder = new TextEncoder();

const MAX_PAYLOAD_SIZE = 64 * 1024;

function parseVerificationJson(data: Uint8Array): Record<string, unknown> {
  return parseJsonObject(data, {
    maxBytes: MAX_PAYLOAD_SIZE,
    payloadName: 'Verification payload',
  });
}

export function encodeResponseAuth(payload: ResponseAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeResponseAuth(data: Uint8Array): ResponseAuthPayload {
  return responseAuthFromObject(parseVerificationJson(data));
}

/**
 * Validate an already-parsed JSON value as a ResponseAuth payload. The bytes
 * wire path (`decodeResponseAuth`) and embedded-object callers share this core
 * so field validation can never diverge.
 */
export function responseAuthFromObject(raw: unknown): ResponseAuthPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version;
  if (version !== 1) {
    throw new Error(`Unsupported response auth version: ${String(version)}`);
  }

  const result: ResponseAuthPayload = {
    version,
    requestId: requireStringField(obj, 'requestId'),
    buyerPeerId: requireStringField(obj, 'buyerPeerId'),
    sellerPeerId: requireStringField(obj, 'sellerPeerId'),
    advertisedService: requireStringField(obj, 'advertisedService'),
    provider: requireStringField(obj, 'provider'),
    statusCode: requireFiniteNumberField(obj, 'statusCode'),
    requestHash: requireStringField(obj, 'requestHash'),
    responseHash: requireStringField(obj, 'responseHash'),
    responseStartedAt: requireFiniteNumberField(obj, 'responseStartedAt'),
    responseCompletedAt: requireFiniteNumberField(obj, 'responseCompletedAt'),
    signature: requireStringField(obj, 'signature'),
  };
  if (typeof obj.channelId === 'string' && obj.channelId.length > 0) {
    result.channelId = obj.channelId;
  }
  return result;
}
