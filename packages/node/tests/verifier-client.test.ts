import { EventLog, Interface, Log, Wallet, type Provider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DIFF_PENALTY_BPS,
  DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS,
  POINTS_POLICY_REGISTRY_ABI,
  VERIFICATION_ABI,
  VERIFICATION_POINTS_POLICY_ABI,
  VERIFIER_VERDICT_DIFF,
  VerifierClient,
  serviceHash,
  type SubmitVerificationBundleInput,
} from '../src/payments/evm/verifier-client.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);
const VERIFICATION_POLICY_ADDRESS = '0x' + '12'.repeat(20);
const POINTS_POLICY_REGISTRY_ADDRESS = '0x' + '13'.repeat(20);
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
      evidenceHash: '0x' + '99'.repeat(32),
      evidenceUri: 'ipfs://bafytest',
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
      input.evidenceHash,
      input.evidenceUri,
      [{ agentId: 9n, serviceHash: SERVICE_HASH, verdict: VERIFIER_VERDICT_DIFF, modelShareBps: 2500 }],
    );
  });

  it('separates verification status from points-policy configuration', () => {
    const iface = new Interface(VERIFICATION_ABI);
    const policyIface = new Interface(VERIFICATION_POINTS_POLICY_ABI);
    const registryIface = new Interface(POINTS_POLICY_REGISTRY_ABI);
    expect(iface.getFunction('submitVerificationBundle')).not.toBeNull();
    expect(iface.getFunction('isVerificationSubmitted')).not.toBeNull();
    expect(iface.getFunction('verificationBundle')).not.toBeNull();
    expect(iface.getFunction('activeAgentDiffVerifierCount')).not.toBeNull();
    expect(iface.getFunction('activeServiceDiffVerifierCount')).not.toBeNull();
    expect(iface.getFunction('latestVerifierVerdict')).not.toBeNull();
    expect(iface.getFunction('clearVerifierVerdict')).not.toBeNull();
    expect(iface.getFunction('claimVerifierReward')).toBeNull();
    expect(iface.getFunction('pendingVerifierReward')).toBeNull();
    expect(iface.getFunction('epochCreditUsdMicros')).toBeNull();
    expect(iface.getFunction('emissionsGate')).toBeNull();
    expect(iface.getFunction('currentEpoch')).toBeNull();
    expect(iface.getFunction('agentPointsPenaltyBps')).toBeNull();
    expect(policyIface.getFunction('minDistinctDiffVerifiers')).not.toBeNull();
    expect(policyIface.getFunction('diffPenaltyBps')).not.toBeNull();
    expect(registryIface.getFunction('isPolicyRegistered')).not.toBeNull();
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

  it('keeps the policy state in shadow mode when adapter wiring is absent', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });

    await expect(client.verificationPolicyState()).resolves.toEqual({
      registered: false,
      minDistinctDiffVerifiers: DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS,
      diffPenaltyBps: DEFAULT_DIFF_PENALTY_BPS,
    });
  });

  it('reads activation and corroboration from the adapter and points registry', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
      verificationPointsPolicyAddress: VERIFICATION_POLICY_ADDRESS,
      pointsPolicyRegistryAddress: POINTS_POLICY_REGISTRY_ADDRESS,
    });
    (client as any)._verificationPointsPolicyInstance = {
      getFunction: (name: string) => async () => name === 'minDistinctDiffVerifiers' ? 3n : 7500n,
    };
    (client as any)._pointsPolicyRegistryInstance = {
      getFunction: () => async () => true,
    };

    await expect(client.verificationPolicyState()).resolves.toEqual({
      registered: true,
      minDistinctDiffVerifiers: 3,
      diffPenaltyBps: 7500,
    });
  });

  it('exposes shared bundle and compact result event shapes', () => {
    const iface = new Interface(VERIFICATION_ABI);
    const bundle = iface.getEvent('VerificationBundleSubmitted');
    expect(bundle?.inputs.map((input) => input.name)).toEqual([
      'evidenceHash',
      'verifier',
      'resultCount',
      'evidenceUri',
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

  it('parses the on-chain IPFS evidence URI from bundle events', () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const iface = new Interface(VERIFICATION_ABI);
    const fragment = iface.getEvent('VerificationBundleSubmitted')!;
    const evidenceUri = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghpm';
    const encoded = iface.encodeEventLog(fragment, [AUDIT_ID, VERIFICATION_ADDRESS, 1, evidenceUri]);
    const log = new Log({
      transactionHash: '0x' + '22'.repeat(32),
      blockHash: '0x' + '33'.repeat(32),
      blockNumber: 12,
      removed: false,
      address: VERIFICATION_ADDRESS,
      data: encoded.data,
      topics: encoded.topics,
      index: 3,
      transactionIndex: 1,
    }, null as unknown as Provider);
    const parsed = (client as unknown as {
      _bundleEvents(logs: readonly unknown[]): Array<{ evidenceUri: string }>;
    })._bundleEvents([new EventLog(log, iface, fragment)]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.evidenceUri).toBe(evidenceUri);
  });
});
