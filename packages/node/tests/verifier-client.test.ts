import { Interface, Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_ABI,
  VERIFIER_VERDICT_DIFF,
  VerifierClient,
  serviceHash,
  type SubmitVerificationResultInput,
} from '../src/payments/evm/verifier-client.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);
const AUDIT_ID = '0x' + '11'.repeat(32);
const SERVICE_HASH = '0x' + '44'.repeat(32);

describe('VerifierClient combined ABI', () => {
  it('normalizes service names before hashing', () => {
    expect(serviceHash('  GPT-5.6-SOL ')).toBe(serviceHash('gpt-5.6-sol'));
  });

  it('encodes one final attestation without commitments or relay claims', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xattest');
    (client as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const input: SubmitVerificationResultInput = {
      auditId: AUDIT_ID,
      agentId: 9,
      serviceHash: SERVICE_HASH,
      verdict: VERIFIER_VERDICT_DIFF,
      expectedEpoch: 7,
      modelShareBps: 2500,
      probeCount: 100,
      evidenceHash: '0x' + '99'.repeat(32),
    };

    await expect(client.submitVerificationResult(signer, input)).resolves.toBe('0xattest');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFICATION_ABI,
      'submitVerificationResult',
      AUDIT_ID,
      9n,
      SERVICE_HASH,
      VERIFIER_VERDICT_DIFF,
      7n,
      2500,
      100,
      input.evidenceHash,
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
    expect(iface.getFunction('submitVerificationResult')).not.toBeNull();
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

  it('preserves the direct attestation event shape', () => {
    const iface = new Interface(VERIFICATION_ABI);
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
