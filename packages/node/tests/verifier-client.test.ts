import { Interface, Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFIER_REGISTRY_ABI,
  VERIFIER_REWARDS_ABI,
  VERIFIER_VERDICT_DIFF,
  VerifierRegistryClient,
  VerifierRewardsClient,
  serviceHash,
  type SubmitVerificationResultInput,
} from '../src/payments/evm/verifier-client.js';

const REGISTRY_ADDRESS = '0x' + '10'.repeat(20);
const REWARDS_ADDRESS = '0x' + '20'.repeat(20);
const AUDIT_ID = '0x' + '11'.repeat(32);
const SERVICE_HASH = '0x' + '44'.repeat(32);

describe('VerifierRegistryClient direct ABI', () => {
  it('normalizes service names before hashing', () => {
    expect(serviceHash('  GPT-5.6-SOL ')).toBe(serviceHash('gpt-5.6-sol'));
  });

  it('encodes one final attestation without commitments or relay claims', async () => {
    const registry = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: REGISTRY_ADDRESS,
    });
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xattest');
    (registry as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const input: SubmitVerificationResultInput = {
      auditId: AUDIT_ID,
      agentId: 9,
      serviceHash: SERVICE_HASH,
      verdict: VERIFIER_VERDICT_DIFF,
      expectedEpoch: 7,
      modelShareBps: 2500,
      probeCount: 100,
      metrics: {
        windowStartedAt: 1_800_000_000,
        windowEndedAt: 1_800_000_600,
        eligibleAttempts: 100,
        successfulAttempts: 92,
        p50TtftMs: 120,
        p95TtftMs: 450,
        p50OutputTokensPerSecondMilli: 32_500,
        schemaVersion: 1,
        observationsRoot: '0x' + '88'.repeat(32),
      },
      evidenceHash: '0x' + '99'.repeat(32),
    };

    await expect(registry.submitVerificationResult(signer, input)).resolves.toBe('0xattest');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFIER_REGISTRY_ABI,
      'submitVerificationResult',
      AUDIT_ID,
      9n,
      SERVICE_HASH,
      VERIFIER_VERDICT_DIFF,
      7n,
      2500,
      100,
      [1_800_000_000, 1_800_000_600, 100, 92, 120, 450, 32_500, 1, input.metrics.observationsRoot],
      input.evidenceHash,
    );
  });

  it('contains no commitment, reveal, treasury, or force-claim functions', () => {
    const iface = new Interface(VERIFIER_REGISTRY_ABI);
    expect(iface.getFunction('commitProbes')).toBeNull();
    expect(iface.getFunction('revealProbeSet')).toBeNull();
    expect(iface.getFunction('relayTreasury')).toBeNull();
    expect(iface.getFunction('forceClaimRelayJob')).toBeNull();
  });

  it('exposes the compact direct attestation event', () => {
    const iface = new Interface(VERIFIER_REGISTRY_ABI);
    const event = iface.getEvent('AttestationSubmitted');
    expect(event?.inputs.map((input) => input.name)).toEqual([
      'auditId',
      'verifier',
      'agentId',
      'serviceHash',
      'verdict',
      'modelShareBps',
      'evidenceHash',
      'probeCount',
      'credited',
      'epoch',
    ]);
  });
});

describe('VerifierRewardsClient verifier-only ABI', () => {
  it('encodes verifier claims without delegate methods', async () => {
    const rewards = new VerifierRewardsClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: REWARDS_ADDRESS,
    });
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xclaim');
    (rewards as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;

    await expect(rewards.claimVerifierReward(signer, 7)).resolves.toBe('0xclaim');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFIER_REWARDS_ABI,
      'claimVerifierReward',
      7n,
    );

    const iface = new Interface(VERIFIER_REWARDS_ABI);
    expect(iface.getFunction('claimDelegateReward')).toBeNull();
    expect(iface.getFunction('pendingDelegateReward')).toBeNull();
  });
});
