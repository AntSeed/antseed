import { Signature } from 'ethers';
import type {
  DelegateHelloPayload,
  DelegateVoucherPayload,
  DelegateWelcomePayload,
  ProbeJobRequestPayload,
  ProbeJobResultPayload,
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

/** Require a 0x-prefixed hex string of one of the given byte lengths. */
function requireHexBytesField(
  obj: Record<string, unknown>,
  field: string,
  byteLengths: number[],
): string {
  const value = requireStringField(obj, field);
  if (!/^0x[0-9a-fA-F]*$/.test(value) || !byteLengths.includes((value.length - 2) / 2)) {
    throw new Error(
      `Delegation payload field "${field}" must be 0x-prefixed hex of ${byteLengths.join(' or ')} byte(s)`,
    );
  }
  return value;
}

/**
 * Require an ECDSA signature field and normalize it to the canonical 65-byte
 * (r,s,v) serialization. EIP-2098 compact (64-byte) signatures are accepted
 * on the wire, but the on-chain claim path (OZ `ECDSA.recover(bytes32,bytes)`)
 * reverts on any length other than 65 — a voucher persisted in compact form
 * would verify locally (ethers accepts both forms) yet be unclaimable, so
 * canonicalize before the payload reaches any caller. This also rejects
 * malleable high-s signatures and normalizes v to 27/28, matching what the
 * contract accepts.
 */
function requireCanonicalSignatureField(obj: Record<string, unknown>, field: string): string {
  const value = requireHexBytesField(obj, field, [64, 65]);
  try {
    return Signature.from(value).serialized;
  } catch (err) {
    throw new Error(
      `Delegation payload field "${field}" is not a valid ECDSA signature: `
      + (err instanceof Error ? err.message : String(err)),
    );
  }
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

export function encodeDelegateVoucher(payload: DelegateVoucherPayload): Uint8Array {
  return checkEncodedSize(encoder.encode(JSON.stringify(payload)), MAX_CONTROL_PAYLOAD_SIZE, 'DelegateVoucher');
}

export function decodeDelegateVoucher(data: Uint8Array): DelegateVoucherPayload {
  const obj = parseDelegationJson(data, MAX_CONTROL_PAYLOAD_SIZE);
  return {
    version: requireVersion1(obj),
    chainId: requireFiniteNumberField(obj, 'chainId'),
    // Addresses are 20 bytes; the probe-set commitment is a bytes32 hash; the
    // signature is canonicalized to the 65-byte (r,s,v) form the on-chain
    // claim accepts (see requireCanonicalSignatureField).
    registry: requireHexBytesField(obj, 'registry', [20]),
    buyer: requireHexBytesField(obj, 'buyer', [20]),
    probeCommitment: requireHexBytesField(obj, 'probeCommitment', [32]),
    credits: requireFiniteNumberField(obj, 'credits'),
    nonce: requireStringField(obj, 'nonce'),
    deadline: requireFiniteNumberField(obj, 'deadline'),
    signature: requireCanonicalSignatureField(obj, 'signature'),
  };
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
