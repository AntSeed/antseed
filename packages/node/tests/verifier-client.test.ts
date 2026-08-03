import { Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFIER_REGISTRY_ABI,
  VERIFIER_VERDICT_DIFF,
  VerifierRegistryClient,
  serviceHash,
  type AuditJob,
  type CommitProbesInput,
  type SubmitAttestationInput,
} from '../src/payments/evm/verifier-client.js';

const ADDRESS = '0x' + '10'.repeat(20);
const AUDIT_ID = '0x' + '11'.repeat(32);

function client(): VerifierRegistryClient {
  return new VerifierRegistryClient({
    rpcUrl: 'http://127.0.0.1:1',
    contractAddress: ADDRESS,
  });
}

function auditJob(): AuditJob {
  return {
    auditId: AUDIT_ID,
    jobIndex: 7,
    sellerPeerId: '0x' + '33'.repeat(20),
    serviceHash: '0x' + '44'.repeat(32),
    requestHash: '0x' + '55'.repeat(32),
    jobSalt: '0x' + '66'.repeat(32),
    executeAfter: 1_800_000_000,
    executeBefore: 1_800_000_600,
  };
}

describe('VerifierRegistryClient current ABI', () => {
  it('matches the Forge/cast tuple vector for hashAuditJob', () => {
    const encoded = new Interface(VERIFIER_REGISTRY_ABI).encodeFunctionData('hashAuditJob', [[
      AUDIT_ID,
      7,
      '0x' + '33'.repeat(20),
      '0x' + '44'.repeat(32),
      '0x' + '55'.repeat(32),
      '0x' + '66'.repeat(32),
      1_800_000_000,
      1_800_000_600,
    ]]);
    expect(encoded).toBe(
      '0x802ae631'
      + '1111111111111111111111111111111111111111111111111111111111111111'
      + '0000000000000000000000000000000000000000000000000000000000000007'
      + '0000000000000000000000003333333333333333333333333333333333333333'
      + '4444444444444444444444444444444444444444444444444444444444444444'
      + '5555555555555555555555555555555555555555555555555555555555555555'
      + '6666666666666666666666666666666666666666666666666666666666666666'
      + '000000000000000000000000000000000000000000000000000000006b49d200'
      + '000000000000000000000000000000000000000000000000000000006b49d458',
    );
  });

  it('encodes commitProbes against only the current registry arguments', async () => {
    const registry = client();
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xcommit');
    (registry as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const input: CommitProbesInput = {
      auditId: AUDIT_ID,
      targetCommitment: '0x' + '12'.repeat(32),
      probeRoot: '0x' + '13'.repeat(32),
      auditJobRoot: '0x' + '14'.repeat(32),
      referenceId: '0x' + '15'.repeat(32),
      verifierConfigHash: '0x' + '16'.repeat(32),
      probeCount: 100,
      jobCount: 10,
      payoutPerJobUsdc: 2500n,
    };

    await expect(registry.commitProbes(signer, input)).resolves.toBe('0xcommit');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFIER_REGISTRY_ABI,
      'commitProbes',
      input.auditId,
      input.targetCommitment,
      input.probeRoot,
      input.auditJobRoot,
      input.referenceId,
      input.verifierConfigHash,
      input.probeCount,
      input.jobCount,
      input.payoutPerJobUsdc,
    );
  });

  it('encodes metrics and relay claims in the exact submitAttestation tuple order', async () => {
    const registry = client();
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xattest');
    (registry as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const job = auditJob();
    const input: SubmitAttestationInput = {
      auditId: AUDIT_ID,
      agentId: 9,
      serviceHash: job.serviceHash,
      targetSalt: '0x' + '77'.repeat(32),
      verdict: VERIFIER_VERDICT_DIFF,
      modelShareBps: 2500,
      metrics: {
        windowStartedAt: 1_800_000_000,
        windowEndedAt: 1_800_000_600,
        eligibleAttempts: 10,
        successfulAttempts: 8,
        p50TtftMs: 120,
        p95TtftMs: 450,
        p50OutputTokensPerSecondMilli: 32_500,
        schemaVersion: 1,
        observationsRoot: '0x' + '88'.repeat(32),
      },
      evidenceHash: '0x' + '99'.repeat(32),
      evidenceUri: '',
      relayClaims: [{
        job,
        jobProof: ['0x' + 'aa'.repeat(32)],
        assignment: {
          auditId: job.auditId,
          jobIndex: job.jobIndex,
          attempt: 0,
          relayBuyer: '0x' + '22'.repeat(20),
          payoutPerJobUsdc: 2500n,
          executeAfter: job.executeAfter,
          executeBefore: job.executeBefore,
        },
        verifierSignature: '0x123456',
        responseAuthPayload: '0x1234',
      }],
    };

    await expect(registry.submitAttestation(signer, input)).resolves.toBe('0xattest');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFIER_REGISTRY_ABI,
      'submitAttestation',
      AUDIT_ID,
      9n,
      job.serviceHash,
      input.targetSalt,
      VERIFIER_VERDICT_DIFF,
      2500,
      [1_800_000_000, 1_800_000_600, 10, 8, 120, 450, 32_500, 1, input.metrics.observationsRoot],
      input.evidenceHash,
      '',
      [[
        [
          job.auditId,
          job.jobIndex,
          job.sellerPeerId,
          job.serviceHash,
          job.requestHash,
          job.jobSalt,
          job.executeAfter,
          job.executeBefore,
        ],
        input.relayClaims[0]!.jobProof,
        [
          job.auditId,
          job.jobIndex,
          0,
          '0x' + '22'.repeat(20),
          2500n,
          job.executeAfter,
          job.executeBefore,
        ],
        '0x123456',
        '0x1234',
      ]],
    );
  });

  it('decodes current audit, attestation, and response auth read tuples', async () => {
    const registry = client();
    const auditRaw = [
      '0x' + '21'.repeat(20),
      '0x' + '22'.repeat(32),
      '0x' + '23'.repeat(32),
      '0x' + '24'.repeat(32),
      '0x' + '25'.repeat(32),
      '0x' + '26'.repeat(32),
      4n,
      100n,
      10n,
      2500n,
      25000n,
      7500n,
      1_800_000_000n,
      1_800_000_120n,
      1_800_000_720n,
      1_800_022_320n,
      1_802_614_320n,
      1_800_000_800n,
      true,
      '0x' + '27'.repeat(32),
      '',
    ];
    const attestationRaw = [
      AUDIT_ID,
      '0x' + '28'.repeat(20),
      9n,
      '0x' + '29'.repeat(32),
      2n,
      2500n,
      1_800_000_800n,
      '0x' + '30'.repeat(32),
    ];
    const responseAuthRaw = [
      '0x' + '31'.repeat(20),
      '0x' + '32'.repeat(20),
      '0x' + '33'.repeat(32),
      200n,
      '0x' + '34'.repeat(32),
      '0x' + '35'.repeat(32),
      1_800_000_120_000n,
      1_800_000_121_500n,
    ];
    const contract = {
      getFunction: (name: string) => async () => {
        if (name === 'getAudit') return auditRaw;
        if (name === 'getAttestation') return attestationRaw;
        if (name === 'parseResponseAuthPayload') return responseAuthRaw;
        throw new Error(`unexpected ${name}`);
      },
    };
    (registry as unknown as { _contract: () => unknown })._contract = () => contract;

    await expect(registry.getAudit(AUDIT_ID)).resolves.toMatchObject({
      committer: auditRaw[0],
      commitSequence: 4n,
      probeCount: 100,
      jobCount: 10,
      payoutPerJobUsdc: 2500n,
      attested: true,
    });
    await expect(registry.getAttestation(AUDIT_ID)).resolves.toMatchObject({
      auditId: AUDIT_ID,
      agentId: 9n,
      verdict: VERIFIER_VERDICT_DIFF,
      modelShareBps: 2500,
    });
    await expect(registry.parseResponseAuthPayload('0x1234')).resolves.toMatchObject({
      buyer: responseAuthRaw[0],
      seller: responseAuthRaw[1],
      statusCode: 200,
      responseStartedAt: 1_800_000_120_000,
      responseCompletedAt: 1_800_000_121_500,
    });
  });

  it('normalizes service spelling exactly once', () => {
    expect(serviceHash('  GPT-5.6-SOL  ')).toBe(keccak256(toUtf8Bytes('gpt-5.6-sol')));
    expect(() => serviceHash('   ')).toThrow(/empty/);
  });
});
