import { Interface, Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_ABI,
  VERIFIER_VERDICT_DIFF,
  VerifierClient,
  serviceHash,
  type SubmitVerificationBundleInput,
} from '../src/payments/evm/verifier-client.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);
const AUDIT_ID = '0x' + '11'.repeat(32);
const SERVICE_HASH = '0x' + '44'.repeat(32);

describe('VerifierClient combined ABI', () => {
  it('normalizes service names before hashing', () => {
    expect(serviceHash('  GPT-5.6-SOL ')).toBe(serviceHash('gpt-5.6-sol'));
  });

  it('encodes one per-model verification bundle', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xattest');
    (client as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const input: SubmitVerificationBundleInput = {
      expectedEpoch: 7,
      totalAuditCostUsdMicros: 1_500_000,
      evidenceHash: '0x' + '99'.repeat(32),
      results: [{
        agentId: 9,
        serviceHash: SERVICE_HASH,
        verdict: VERIFIER_VERDICT_DIFF,
        modelShareBps: 2500,
      }],
    };

    await expect(client.submitVerificationBundle(signer, input)).resolves.toBe('0xattest');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFICATION_ABI,
      'submitVerificationBundle',
      7n,
      1_500_000n,
      input.evidenceHash,
      [{ agentId: 9n, serviceHash: SERVICE_HASH, verdict: VERIFIER_VERDICT_DIFF, modelShareBps: 2500 }],
    );
  });

  it('encodes verifier rewards through the same contract', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xclaim');
    (client as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;

    await expect(client.claimVerifierReward(signer, 7)).resolves.toBe('0xclaim');
    expect(execWrite).toHaveBeenCalledWith(signer, VERIFICATION_ABI, 'claimVerifierReward', 7n);
  });

  it('exposes one compact verification and reward ABI', () => {
    const iface = new Interface(VERIFICATION_ABI);
    expect(iface.getFunction('submitVerificationBundle')).not.toBeNull();
    expect(iface.getFunction('isVerificationSubmitted')).not.toBeNull();
    expect(iface.getFunction('claimVerifierReward')).not.toBeNull();
    expect(iface.getFunction('latestAttestation')).toBeNull();
    expect(iface.getFunction('servicePointsPenaltyBps')).toBeNull();
    expect(iface.getFunction('epochRewardClaimed')).toBeNull();
    expect(iface.getFunction('getAttestation')).toBeNull();
    expect(iface.getFunction('verificationStats')).toBeNull();
    expect(iface.getFunction('agentVerificationStats')).toBeNull();
    expect(iface.getFunction('verifierRegistry')).toBeNull();
    expect(iface.getFunction('gate')).toBeNull();
    expect(iface.getFunction('commitProbes')).toBeNull();
    expect(iface.getFunction('claimDelegateReward')).toBeNull();
  });

  it('exposes shared bundle and compact result event shapes', () => {
    const iface = new Interface(VERIFICATION_ABI);
    const bundle = iface.getEvent('VerificationBundleSubmitted');
    expect(bundle?.inputs.map((input) => input.name)).toEqual([
      'evidenceHash',
      'verifier',
      'epoch',
      'totalAuditCostUsdMicros',
      'awardedCreditUsdMicros',
      'resultCount',
    ]);
    const result = iface.getEvent('VerificationResultSubmitted');
    expect(result?.inputs.map((input) => input.name)).toEqual([
      'evidenceHash',
      'agentId',
      'serviceHash',
      'verdict',
      'modelShareBps',
    ]);
  });
});
