import type {
  AuditRelayJobPayload,
  AuditRelayResultPayload,
  RelayHelloPayload,
  RelayWelcomePayload,
} from '../types/protocol.js';
import { parseJsonObject, requireFiniteNumberField, requireStringField } from '../utils/json-codec.js';

const encoder = new TextEncoder();
const MAX_CONTROL_PAYLOAD_SIZE = 16 * 1024;
const MAX_JOB_PAYLOAD_SIZE = 2 * 1024 * 1024;
const MAX_RESULT_PAYLOAD_SIZE = 8 * 1024 * 1024;

function encode(payload: unknown, maxBytes: number, name: string): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > maxBytes) throw new Error(`${name} too large to encode: ${bytes.length} > ${maxBytes}`);
  return bytes;
}

function parse(data: Uint8Array, maxBytes: number): Record<string, unknown> {
  return parseJsonObject(data, { maxBytes, payloadName: 'Audit relay payload' });
}

function version1(value: unknown): 1 {
  if (value !== 1) throw new Error(`Unsupported audit relay payload version: ${String(value)}`);
  return 1;
}

function objectField(object: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = object[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Audit relay field "${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArrayField(object: Record<string, unknown>, field: string): string[] {
  const value = object[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Audit relay field "${field}" must be a string array`);
  }
  return value;
}

function booleanField(object: Record<string, unknown>, field: string): boolean {
  const value = object[field];
  if (typeof value !== 'boolean') throw new Error(`Audit relay field "${field}" must be a boolean`);
  return value;
}

export function encodeRelayHello(payload: RelayHelloPayload): Uint8Array {
  return encode(payload, MAX_CONTROL_PAYLOAD_SIZE, 'RelayHello');
}

export function decodeRelayHello(data: Uint8Array): RelayHelloPayload {
  const object = parse(data, MAX_CONTROL_PAYLOAD_SIZE);
  const payload: RelayHelloPayload = {
    version: version1(object.version),
    chainId: requireStringField(object, 'chainId'),
    registryAddress: requireStringField(object, 'registryAddress'),
    treasuryAddress: requireStringField(object, 'treasuryAddress'),
    minPayoutPerJobUsdc: requireStringField(object, 'minPayoutPerJobUsdc'),
  };
  if (object.maxConcurrentJobs !== undefined) {
    payload.maxConcurrentJobs = requireFiniteNumberField(object, 'maxConcurrentJobs');
  }
  return payload;
}

export function encodeRelayWelcome(payload: RelayWelcomePayload): Uint8Array {
  return encode(payload, MAX_CONTROL_PAYLOAD_SIZE, 'RelayWelcome');
}

export function decodeRelayWelcome(data: Uint8Array): RelayWelcomePayload {
  const object = parse(data, MAX_CONTROL_PAYLOAD_SIZE);
  const payload: RelayWelcomePayload = {
    version: version1(object.version),
    accepted: booleanField(object, 'accepted'),
  };
  if (typeof object.reason === 'string' && object.reason) payload.reason = object.reason;
  return payload;
}

export function encodeAuditRelayJob(payload: AuditRelayJobPayload): Uint8Array {
  return encode(payload, MAX_JOB_PAYLOAD_SIZE, 'AuditRelayJob');
}

export function decodeAuditRelayJob(data: Uint8Array): AuditRelayJobPayload {
  const object = parse(data, MAX_JOB_PAYLOAD_SIZE);
  const snapshot = objectField(object, 'auditSnapshot');
  const job = objectField(object, 'job');
  const assignment = objectField(object, 'assignment');
  return {
    version: version1(object.version),
    jobId: requireStringField(object, 'jobId'),
    chainId: requireStringField(object, 'chainId'),
    registryAddress: requireStringField(object, 'registryAddress'),
    treasuryAddress: requireStringField(object, 'treasuryAddress'),
    auditSnapshot: {
      committer: requireStringField(snapshot, 'committer'),
      auditJobRoot: requireStringField(snapshot, 'auditJobRoot'),
      jobCount: requireFiniteNumberField(snapshot, 'jobCount'),
      payoutPerJobUsdc: requireStringField(snapshot, 'payoutPerJobUsdc'),
      reservedRelayBudgetUsdc: requireStringField(snapshot, 'reservedRelayBudgetUsdc'),
      executeAfter: requireFiniteNumberField(snapshot, 'executeAfter'),
      executeBefore: requireFiniteNumberField(snapshot, 'executeBefore'),
      forceClaimAvailableAt: requireFiniteNumberField(snapshot, 'forceClaimAvailableAt'),
      forceClaimDeadline: requireFiniteNumberField(snapshot, 'forceClaimDeadline'),
      attested: booleanField(snapshot, 'attested'),
    },
    job: {
      auditId: requireStringField(job, 'auditId'),
      jobIndex: requireFiniteNumberField(job, 'jobIndex'),
      sellerPeerId: requireStringField(job, 'sellerPeerId'),
      serviceHash: requireStringField(job, 'serviceHash'),
      requestHash: requireStringField(job, 'requestHash'),
      jobSalt: requireStringField(job, 'jobSalt'),
      executeAfter: requireFiniteNumberField(job, 'executeAfter'),
      executeBefore: requireFiniteNumberField(job, 'executeBefore'),
    },
    jobProof: stringArrayField(object, 'jobProof'),
    assignment: {
      auditId: requireStringField(assignment, 'auditId'),
      jobIndex: requireFiniteNumberField(assignment, 'jobIndex'),
      attempt: requireFiniteNumberField(assignment, 'attempt'),
      relayBuyer: requireStringField(assignment, 'relayBuyer'),
      payoutPerJobUsdc: requireStringField(assignment, 'payoutPerJobUsdc'),
      executeAfter: requireFiniteNumberField(assignment, 'executeAfter'),
      executeBefore: requireFiniteNumberField(assignment, 'executeBefore'),
    },
    verifierSignature: requireStringField(object, 'verifierSignature'),
    targetPeerId: requireStringField(object, 'targetPeerId'),
    service: requireStringField(object, 'service'),
    requestBytesBase64: requireStringField(object, 'requestBytesBase64'),
    payoutPerJobUsdc: requireStringField(object, 'payoutPerJobUsdc'),
    timeoutMs: requireFiniteNumberField(object, 'timeoutMs'),
  };
}

export function encodeAuditRelayResult(payload: AuditRelayResultPayload): Uint8Array {
  return encode(payload, MAX_RESULT_PAYLOAD_SIZE, 'AuditRelayResult');
}

export function decodeAuditRelayResult(data: Uint8Array): AuditRelayResultPayload {
  const object = parse(data, MAX_RESULT_PAYLOAD_SIZE);
  if (object.status !== 'ok' && object.status !== 'error') throw new Error('Audit relay result status is invalid');
  const payload: AuditRelayResultPayload = {
    version: version1(object.version),
    jobId: requireStringField(object, 'jobId'),
    status: object.status,
  };
  if (typeof object.error === 'string') payload.error = object.error;
  if (typeof object.responseBytesBase64 === 'string') payload.responseBytesBase64 = object.responseBytesBase64;
  if (typeof object.responseAuthPayloadBase64 === 'string') payload.responseAuthPayloadBase64 = object.responseAuthPayloadBase64;
  if (typeof object.sellerChargeUsdc === 'string') payload.sellerChargeUsdc = object.sellerChargeUsdc;
  if (object.paymentMetadata !== undefined) payload.paymentMetadata = objectField(object, 'paymentMetadata');
  if (payload.status === 'ok' && (
    !payload.responseBytesBase64
    || !payload.responseAuthPayloadBase64
    || payload.sellerChargeUsdc === undefined
    || !payload.paymentMetadata
  )) {
    throw new Error('Successful audit relay result is incomplete');
  }
  return payload;
}
