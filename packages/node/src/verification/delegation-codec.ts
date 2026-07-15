import type {
  DelegateHelloPayload,
  DelegateWelcomePayload,
  ProbeJobRequestPayload,
  ProbeJobResultPayload,
  TargetQueryPayload,
  TargetSuggestionPayload,
} from '../types/protocol.js';
import { parseJsonObject, requireFiniteNumberField, requireStringField } from '../utils/json-codec.js';
import { decodeResponseAuth } from './codec.js';

const encoder = new TextEncoder();

/** Hello/Welcome are tiny control messages. */
const MAX_CONTROL_PAYLOAD_SIZE = 16 * 1024;
/** A job carries one stealth chat request body — small by construction. */
const MAX_JOB_PAYLOAD_SIZE = 1 * 1024 * 1024;
/** A result carries one chat completion body plus the ResponseAuth. */
const MAX_RESULT_PAYLOAD_SIZE = 4 * 1024 * 1024;

function parseDelegationJson(data: Uint8Array, maxBytes: number): Record<string, unknown> {
  return parseJsonObject(data, { maxBytes, payloadName: 'Delegation payload' });
}

/**
 * Encode-side mirror of the decoders' size limits. Encoders must enforce the
 * same cap the peer's decoder does — otherwise an oversize payload is sent
 * successfully and silently dropped on the other end (for a voucher, that
 * means the delegate loses its only claim proof with no error at the source).
 */
function checkEncodedSize(bytes: Uint8Array, maxBytes: number, payloadName: string): Uint8Array {
  if (bytes.length > maxBytes) {
    throw new Error(`${payloadName} too large to encode: ${bytes.length} > ${maxBytes}`);
  }
  return bytes;
}

function requireVersion1(obj: Record<string, unknown>): 1 {
  if (obj.version !== 1) {
    throw new Error(`Unsupported delegation payload version: ${String(obj.version)}`);
  }
  return 1;
}

function requireStringRecord(obj: Record<string, unknown>, field: string): Record<string, string> {
  const value = obj[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Delegation payload field "${field}" must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw new Error(`Delegation payload field "${field}.${key}" must be a string`);
    }
    out[key] = entry;
  }
  return out;
}

export function encodeDelegateHello(payload: DelegateHelloPayload): Uint8Array {
  return checkEncodedSize(encoder.encode(JSON.stringify(payload)), MAX_CONTROL_PAYLOAD_SIZE, 'DelegateHello');
}

export function decodeDelegateHello(data: Uint8Array): DelegateHelloPayload {
  const obj = parseDelegationJson(data, MAX_CONTROL_PAYLOAD_SIZE);
  const result: DelegateHelloPayload = {
    version: requireVersion1(obj),
  };
  if (obj.maxConcurrentJobs !== undefined) {
    result.maxConcurrentJobs = requireFiniteNumberField(obj, 'maxConcurrentJobs');
  }
  return result;
}

export function encodeDelegateWelcome(payload: DelegateWelcomePayload): Uint8Array {
  return checkEncodedSize(encoder.encode(JSON.stringify(payload)), MAX_CONTROL_PAYLOAD_SIZE, 'DelegateWelcome');
}

export function decodeDelegateWelcome(data: Uint8Array): DelegateWelcomePayload {
  const obj = parseDelegationJson(data, MAX_CONTROL_PAYLOAD_SIZE);
  if (typeof obj.accepted !== 'boolean') {
    throw new Error('Delegation payload field "accepted" must be a boolean');
  }
  const result: DelegateWelcomePayload = {
    version: requireVersion1(obj),
    accepted: obj.accepted,
  };
  if (typeof obj.reason === 'string' && obj.reason.length > 0) {
    result.reason = obj.reason;
  }
  return result;
}

export function encodeTargetQuery(payload: TargetQueryPayload): Uint8Array {
  return checkEncodedSize(encoder.encode(JSON.stringify(payload)), MAX_CONTROL_PAYLOAD_SIZE, 'TargetQuery');
}

export function decodeTargetQuery(data: Uint8Array): TargetQueryPayload {
  const obj = parseDelegationJson(data, MAX_CONTROL_PAYLOAD_SIZE);
  return {
    version: requireVersion1(obj),
    queryId: requireStringField(obj, 'queryId'),
    service: requireStringField(obj, 'service'),
  };
}

export function encodeTargetSuggestion(payload: TargetSuggestionPayload): Uint8Array {
  return checkEncodedSize(encoder.encode(JSON.stringify(payload)), MAX_CONTROL_PAYLOAD_SIZE, 'TargetSuggestion');
}

export function decodeTargetSuggestion(data: Uint8Array): TargetSuggestionPayload {
  const obj = parseDelegationJson(data, MAX_CONTROL_PAYLOAD_SIZE);
  const rawSellers = obj.sellers;
  if (!Array.isArray(rawSellers)) {
    throw new Error('Delegation payload field "sellers" must be an array');
  }
  const sellers = rawSellers.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Delegation payload field "sellers[${index}]" must be an object`);
    }
    const sellerObj = entry as Record<string, unknown>;
    return {
      peerId: requireStringField(sellerObj, 'peerId'),
      agentId: requireFiniteNumberField(sellerObj, 'agentId'),
    };
  });
  return {
    version: requireVersion1(obj),
    queryId: requireStringField(obj, 'queryId'),
    service: requireStringField(obj, 'service'),
    sellers,
  };
}

export function encodeProbeJobRequest(payload: ProbeJobRequestPayload): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > MAX_JOB_PAYLOAD_SIZE) {
    throw new Error(`Probe job payload too large: ${bytes.length} > ${MAX_JOB_PAYLOAD_SIZE}`);
  }
  return bytes;
}

export function decodeProbeJobRequest(data: Uint8Array): ProbeJobRequestPayload {
  const obj = parseDelegationJson(data, MAX_JOB_PAYLOAD_SIZE);
  const rawRequest = obj.request;
  if (typeof rawRequest !== 'object' || rawRequest === null || Array.isArray(rawRequest)) {
    throw new Error('Delegation payload field "request" must be an object');
  }
  const requestObj = rawRequest as Record<string, unknown>;
  return {
    version: requireVersion1(obj),
    jobId: requireStringField(obj, 'jobId'),
    targetPeerId: requireStringField(obj, 'targetPeerId'),
    service: requireStringField(obj, 'service'),
    request: {
      requestId: requireStringField(requestObj, 'requestId'),
      method: requireStringField(requestObj, 'method'),
      path: requireStringField(requestObj, 'path'),
      headers: requireStringRecord(requestObj, 'headers'),
      bodyBase64: requireStringField(requestObj, 'bodyBase64'),
    },
    timeoutMs: requireFiniteNumberField(obj, 'timeoutMs'),
  };
}

export function encodeProbeJobResult(payload: ProbeJobResultPayload): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > MAX_RESULT_PAYLOAD_SIZE) {
    throw new Error(`Probe job result payload too large: ${bytes.length} > ${MAX_RESULT_PAYLOAD_SIZE}`);
  }
  return bytes;
}

export function decodeProbeJobResult(data: Uint8Array): ProbeJobResultPayload {
  const obj = parseDelegationJson(data, MAX_RESULT_PAYLOAD_SIZE);
  const status = obj.status;
  if (status !== 'ok' && status !== 'error') {
    throw new Error(`Delegation payload field "status" must be "ok" or "error"`);
  }
  const result: ProbeJobResultPayload = {
    version: requireVersion1(obj),
    jobId: requireStringField(obj, 'jobId'),
    status,
  };
  if (typeof obj.error === 'string' && obj.error.length > 0) {
    result.error = obj.error;
  }
  const rawResponse = obj.response;
  if (rawResponse !== undefined) {
    if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) {
      throw new Error('Delegation payload field "response" must be an object');
    }
    const responseObj = rawResponse as Record<string, unknown>;
    result.response = {
      statusCode: requireFiniteNumberField(responseObj, 'statusCode'),
      headers: requireStringRecord(responseObj, 'headers'),
      bodyBase64: requireStringField(responseObj, 'bodyBase64'),
    };
  }
  if (obj.responseAuth !== undefined) {
    // Re-encode through the ResponseAuth codec so field validation is shared.
    result.responseAuth = decodeResponseAuth(encoder.encode(JSON.stringify(obj.responseAuth)));
  }
  return result;
}
