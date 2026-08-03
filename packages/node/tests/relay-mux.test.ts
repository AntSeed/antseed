import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { MessageType, type AuditRelayJobPayload, type AuditRelayResultPayload } from '../src/types/protocol.js';
import {
  decodeAuditRelayJob,
  decodeAuditRelayResult,
  decodeRelayHello,
  decodeRelayWelcome,
  encodeAuditRelayJob,
  encodeAuditRelayResult,
  encodeRelayHello,
  encodeRelayWelcome,
} from '../src/verification/relay-codec.js';
import { RelayMux } from '../src/verification/relay-mux.js';

function relayJob(overrides?: Partial<AuditRelayJobPayload>): AuditRelayJobPayload {
  return {
    version: 1,
    jobId: 'audit-1:0',
    chainId: 'base-local',
    registryAddress: '0x' + '11'.repeat(20),
    treasuryAddress: '0x' + '22'.repeat(20),
    auditSnapshot: {
      committer: '0x' + '33'.repeat(20),
      auditJobRoot: '0x' + '44'.repeat(32),
      jobCount: 10,
      payoutPerJobUsdc: '2500',
      reservedRelayBudgetUsdc: '25000',
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
      forceClaimAvailableAt: 1_800_022_200,
      forceClaimDeadline: 1_802_614_200,
      attested: false,
    },
    job: {
      auditId: '0x' + '55'.repeat(32),
      jobIndex: 0,
      sellerPeerId: '0x' + '77'.repeat(20),
      serviceHash: '0x' + '88'.repeat(32),
      requestHash: '0x' + '99'.repeat(32),
      jobSalt: '0x' + 'aa'.repeat(32),
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    jobProof: ['0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32), '0x' + 'dd'.repeat(32), '0x' + 'ee'.repeat(32)],
    assignment: {
      auditId: '0x' + '55'.repeat(32),
      jobIndex: 0,
      attempt: 0,
      relayBuyer: '0x' + '66'.repeat(20),
      payoutPerJobUsdc: '2500',
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    verifierSignature: '0x' + 'ff'.repeat(65),
    targetPeerId: '77'.repeat(20),
    service: 'gpt-5.6-sol',
    requestBytesBase64: Buffer.from('request-bytes').toString('base64'),
    payoutPerJobUsdc: '2500',
    timeoutMs: 30_000,
    ...overrides,
  };
}

function muxPair(): { verifier: RelayMux; relay: RelayMux } {
  let verifier!: RelayMux;
  let relay!: RelayMux;
  const pipeTo = (target: () => RelayMux) => (data: Uint8Array): void => {
    const decoded = decodeFrame(data);
    if (!decoded) throw new Error('incomplete frame in test pipe');
    void target().handleFrame(decoded.message);
  };
  verifier = new RelayMux({ send: pipeTo(() => relay) } as unknown as PeerConnection);
  relay = new RelayMux({ send: pipeTo(() => verifier) } as unknown as PeerConnection);
  return { verifier, relay };
}

describe('relay codec', () => {
  it('round-trips hello, welcome, job, and successful result payloads', () => {
    const hello = {
      version: 1 as const,
      chainId: 'base-local',
      registryAddress: '0x' + '11'.repeat(20),
      treasuryAddress: '0x' + '22'.repeat(20),
      minPayoutPerJobUsdc: '1000',
      maxConcurrentJobs: 3,
    };
    expect(decodeRelayHello(encodeRelayHello(hello))).toEqual(hello);

    const welcome = { version: 1 as const, accepted: false, reason: 'chain_mismatch' };
    expect(decodeRelayWelcome(encodeRelayWelcome(welcome))).toEqual(welcome);

    const job = relayJob();
    expect(decodeAuditRelayJob(encodeAuditRelayJob(job))).toEqual(job);

    const result: AuditRelayResultPayload = {
      version: 1,
      jobId: job.jobId,
      status: 'ok',
      responseBytesBase64: Buffer.from('response').toString('base64'),
      responseAuthPayloadBase64: Buffer.from('response-auth').toString('base64'),
      sellerChargeUsdc: '2000',
      paymentMetadata: { channelId: '0x' + 'ab'.repeat(32), cumulativeAmount: '2000' },
    };
    expect(decodeAuditRelayResult(encodeAuditRelayResult(result))).toEqual(result);
  });

  it('rejects malformed assignments and incomplete successful results', () => {
    const invalidAttempt = JSON.parse(new TextDecoder().decode(encodeAuditRelayJob(relayJob()))) as Record<string, unknown>;
    (invalidAttempt.assignment as Record<string, unknown>).attempt = 'third';
    expect(() => decodeAuditRelayJob(new TextEncoder().encode(JSON.stringify(invalidAttempt)))).toThrow(/attempt/i);
    expect(() => decodeAuditRelayResult(new TextEncoder().encode(JSON.stringify({
      version: 1,
      jobId: 'j',
      status: 'ok',
    })))).toThrow(/incomplete/i);
  });
});

describe('RelayMux', () => {
  it('correlates one audit job with its result', async () => {
    const { verifier, relay } = muxPair();
    relay.onJob((job) => {
      relay.sendResult({
        version: 1,
        jobId: job.jobId,
        status: 'error',
        error: 'seller_timeout',
      });
    });

    await expect(verifier.runJob(relayJob(), 1_000)).resolves.toMatchObject({
      jobId: 'audit-1:0',
      status: 'error',
      error: 'seller_timeout',
    });
  });

  it('returns no_job_handler when a relay has no worker', async () => {
    const { verifier } = muxPair();
    await expect(verifier.runJob(relayJob(), 1_000)).resolves.toMatchObject({
      status: 'error',
      error: 'no_job_handler',
    });
  });

  it('classifies only the reserved relay message range', () => {
    expect(RelayMux.isRelayMessage(MessageType.RelayHello)).toBe(true);
    expect(RelayMux.isRelayMessage(MessageType.AuditRelayResult)).toBe(true);
    expect(RelayMux.isRelayMessage(MessageType.VerificationResponseAuth)).toBe(false);
    expect(RelayMux.isRelayMessage(MessageType.Disconnect)).toBe(false);
  });
});
