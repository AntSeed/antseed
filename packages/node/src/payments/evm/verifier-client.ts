import {
  Contract,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
  type AbstractSigner,
  type TypedDataDomain,
} from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface VerifierRegistryClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface VerifierRewardsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

/**
 * On-chain verdict codes. FROZEN mapping shared with
 * AntseedVerifierRegistry.sol and @antseed/fingerprints.
 */
export const VERIFIER_VERDICT_UNKNOWN = 0;
export const VERIFIER_VERDICT_SAME = 1;
export const VERIFIER_VERDICT_DIFF = 2;
export const VERIFIER_VERDICT_UNDETERMINED = 3;

export interface VerifierAttestation {
  verifier: string;
  attestedAt: number;
  verdict: number;
  probeCount: number;
  cohortSize: number;
  evidenceHash: string;
  probeCommitment: string;
}

/** Per-(agentId, service) or per-agent verification accumulators. */
export interface ServiceVerificationStats {
  sameCount: number;
  diffCount: number;
  undeterminedCount: number;
  distinctVerifierCount: number;
  lastVerdict: number;
  lastVerifier: string;
  /**
   * Distinct verifiers whose LATEST verdict is DIFF — a standing, retractable
   * accusation, unlike the monotonic historical `diffCount`. The on-chain
   * points penalty gates on this reaching `minDistinctDiffVerifiers`.
   */
  activeDiffVerifierCount: number;
}

const VERIFIER_REGISTRY_ABI = [
  // Writes
  'function commitProbeSet(bytes32 commitment) external',
  'function submitAttestation(uint256 agentId, bytes32 serviceHash, uint8 verdict, bytes32 evidenceHash, bytes32 probeCommitment, uint32 probeCount, uint32 cohortSize) external',
  'function claimDelegateCredits(tuple(address buyer, bytes32 probeCommitment, uint32 credits, uint256 nonce, uint256 deadline) voucher, bytes signature) external',
  // Reads
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function probeCommittedAt(address verifier, bytes32 commitment) external view returns (uint64)',
  'function lastAuditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64)',
  'function lastCreditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64)',
  'function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns (tuple(address verifier, uint64 attestedAt, uint8 verdict, uint32 probeCount, uint32 cohortSize, bytes32 evidenceHash, bytes32 probeCommitment))',
  'function verificationStats(uint256 agentId, bytes32 serviceHash) external view returns (tuple(uint32 sameCount, uint32 diffCount, uint32 undeterminedCount, uint32 distinctVerifierCount, uint8 lastVerdict, address lastVerifier, uint32 activeDiffVerifierCount))',
  'function agentVerificationStats(uint256 agentId) external view returns (tuple(uint32 sameCount, uint32 diffCount, uint32 undeterminedCount, uint32 distinctVerifierCount, uint8 lastVerdict, address lastVerifier, uint32 activeDiffVerifierCount))',
  'function epochCredits(uint256 epoch, address verifier) external view returns (uint256)',
  'function epochTotalCredits(uint256 epoch) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function auditCooldown() external view returns (uint64)',
  'function maxCreditsPerVerifierPerEpoch() external view returns (uint32)',
  'function minProbeCount() external view returns (uint32)',
  'function delegateShareBps() external view returns (uint16)',
  'function maxDelegateCreditsPerVerifierPerEpoch() external view returns (uint32)',
  'function epochDelegateCredits(uint256 epoch, address delegate) external view returns (uint256)',
  'function epochTotalDelegateCredits(uint256 epoch) external view returns (uint256)',
  'function epochDelegateCreditsGrantedBy(uint256 epoch, address verifier) external view returns (uint256)',
  'function voucherClaimed(bytes32 digest) external view returns (bool)',
  'function commitmentDelegateBudget(address verifier, bytes32 commitment) external view returns (uint256)',
  'function commitmentDelegateCredits(address verifier, bytes32 commitment) external view returns (uint256)',
] as const;

const VERIFIER_REWARDS_ABI = [
  // Writes
  'function claimVerifierReward(uint256 epoch) external',
  'function claimDelegateReward(uint256 epoch) external',
  'function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount)',
  // Reads
  'function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256)',
  'function pendingDelegateReward(uint256 epoch, address delegate) external view returns (uint256)',
  'function verifierEpochBudget(uint256 epoch) external view returns (uint256)',
  'function delegateEpochPool(uint256 epoch) external view returns (uint256)',
  'function epochRewardClaimed(uint256 epoch, address verifier) external view returns (bool)',
  'function epochDelegateRewardClaimed(uint256 epoch, address delegate) external view returns (bool)',
  'function gate() external view returns (address)',
] as const;

const EMISSIONS_GATE_MINI_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function effectiveEpoch() external view returns (uint256)',
] as const;

/**
 * Hash an advertised service name into the bytes32 key used on-chain.
 * Normalization (lowercase + trim) is part of the protocol: every verifier
 * must derive the same key for the same advertised service string.
 */
export function serviceHash(service: string): string {
  return keccak256(toUtf8Bytes(service.trim().toLowerCase()));
}

// =========================================================================
// Delegate vouchers — EIP-712
// =========================================================================

/**
 * EIP-712 DelegateVoucher struct signed by a verifier for a delegate buyer
 * that carried its probe traffic. Mirrors
 * AntseedVerifierRegistry.DELEGATE_VOUCHER_TYPEHASH — frozen with it.
 */
export interface DelegateVoucherMessage {
  /** Buyer (delegate hot wallet / peer) address. Its operator claims. */
  buyer: string;
  /** Probe-set commitment whose credited attestations back the credits. */
  probeCommitment: string;
  credits: number;
  nonce: bigint;
  /** Claim deadline, unix seconds. */
  deadline: number;
}

export const DELEGATE_VOUCHER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  DelegateVoucher: [
    { name: 'buyer', type: 'address' },
    { name: 'probeCommitment', type: 'bytes32' },
    { name: 'credits', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export function makeVerifierRegistryDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedVerifierRegistry',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export async function signDelegateVoucher(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: DelegateVoucherMessage,
): Promise<string> {
  return signer.signTypedData(domain, DELEGATE_VOUCHER_TYPES, msg);
}

/**
 * Recover the signer of a DelegateVoucher. Delegates run this on every
 * voucher they receive and check the result against the verifier peer they
 * are serving — a voucher signed by anyone else is worthless on-chain.
 */
export function recoverDelegateVoucherSigner(
  domain: TypedDataDomain,
  msg: DelegateVoucherMessage,
  signature: string,
): string {
  return verifyTypedData(domain, DELEGATE_VOUCHER_TYPES, msg, signature);
}

function decodeStats(raw: Record<string | number, unknown> & unknown[]): ServiceVerificationStats {
  return {
    sameCount: Number(raw.sameCount ?? raw[0]),
    diffCount: Number(raw.diffCount ?? raw[1]),
    undeterminedCount: Number(raw.undeterminedCount ?? raw[2]),
    distinctVerifierCount: Number(raw.distinctVerifierCount ?? raw[3]),
    lastVerdict: Number(raw.lastVerdict ?? raw[4]),
    lastVerifier: String(raw.lastVerifier ?? raw[5]),
    activeDiffVerifierCount: Number(raw.activeDiffVerifierCount ?? raw[6] ?? 0),
  };
}

/** Client for AntseedVerifierRegistry (whitelist, commitments, attestations). */
export class VerifierRegistryClient extends BaseEvmClient {
  constructor(config: VerifierRegistryClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    return new Contract(this._contractAddress, VERIFIER_REGISTRY_ABI, this._provider);
  }

  async commitProbeSet(signer: AbstractSigner, commitment: string): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'commitProbeSet', commitment);
  }

  async submitAttestation(
    signer: AbstractSigner,
    input: {
      agentId: number | bigint;
      serviceHash: string;
      verdict: number;
      evidenceHash: string;
      probeCommitment: string;
      probeCount: number;
      cohortSize: number;
    },
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'submitAttestation',
      input.agentId,
      input.serviceHash,
      input.verdict,
      input.evidenceHash,
      input.probeCommitment,
      input.probeCount,
      input.cohortSize,
    );
  }

  /**
   * Claim a verifier-signed DelegateVoucher. Must be sent by the operator
   * registered for `voucher.buyer` in AntseedDeposits — the contract credits
   * that operator and rejects any other caller.
   */
  async claimDelegateCredits(
    signer: AbstractSigner,
    voucher: DelegateVoucherMessage,
    signature: string,
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'claimDelegateCredits',
      [voucher.buyer, voucher.probeCommitment, voucher.credits, voucher.nonce, voucher.deadline],
      signature,
    );
  }

  /** True when the voucher with this EIP-712 digest was already claimed. */
  async voucherClaimed(digest: string): Promise<boolean> {
    return this._contract().getFunction('voucherClaimed')(digest);
  }

  /**
   * Delegate-credit budget earned by `verifier`'s credited attestations on
   * `commitment`, and how much of it vouchers have already claimed.
   */
  async commitmentDelegateBudget(verifier: string, commitment: string): Promise<number> {
    const v = await this._contract().getFunction('commitmentDelegateBudget')(verifier, commitment);
    return Number(v);
  }

  async commitmentDelegateCredits(verifier: string, commitment: string): Promise<number> {
    const v = await this._contract().getFunction('commitmentDelegateCredits')(verifier, commitment);
    return Number(v);
  }

  async isApprovedVerifier(verifier: string): Promise<boolean> {
    return this._contract().getFunction('approvedVerifiers')(verifier);
  }

  async epochDelegateCredits(epoch: number, delegate: string): Promise<number> {
    const v = await this._contract().getFunction('epochDelegateCredits')(epoch, delegate);
    return Number(v);
  }

  async epochTotalDelegateCredits(epoch: number): Promise<number> {
    const v = await this._contract().getFunction('epochTotalDelegateCredits')(epoch);
    return Number(v);
  }

  async epochDelegateCreditsGrantedBy(epoch: number, verifier: string): Promise<number> {
    const v = await this._contract().getFunction('epochDelegateCreditsGrantedBy')(epoch, verifier);
    return Number(v);
  }

  async getDelegatePolicy(): Promise<{ delegateShareBps: number; maxDelegateCreditsPerVerifierPerEpoch: number }> {
    const contract = this._contract();
    const [shareBps, maxCredits] = await Promise.all([
      contract.getFunction('delegateShareBps')(),
      contract.getFunction('maxDelegateCreditsPerVerifierPerEpoch')(),
    ]);
    return {
      delegateShareBps: Number(shareBps),
      maxDelegateCreditsPerVerifierPerEpoch: Number(maxCredits),
    };
  }

  async probeCommittedAt(verifier: string, commitment: string): Promise<number> {
    const v = await this._contract().getFunction('probeCommittedAt')(verifier, commitment);
    return Number(v);
  }

  async lastAuditedAt(agentId: number | bigint, service: string): Promise<number> {
    const v = await this._contract().getFunction('lastAuditedAt')(agentId, serviceHash(service));
    return Number(v);
  }

  async lastCreditedAt(agentId: number | bigint, service: string): Promise<number> {
    const v = await this._contract().getFunction('lastCreditedAt')(agentId, serviceHash(service));
    return Number(v);
  }

  async latestAttestation(agentId: number | bigint, service: string): Promise<VerifierAttestation | null> {
    const raw = await this._contract().getFunction('latestAttestation')(agentId, serviceHash(service));
    const attestation: VerifierAttestation = {
      verifier: raw.verifier ?? raw[0],
      attestedAt: Number(raw.attestedAt ?? raw[1]),
      verdict: Number(raw.verdict ?? raw[2]),
      probeCount: Number(raw.probeCount ?? raw[3]),
      cohortSize: Number(raw.cohortSize ?? raw[4]),
      evidenceHash: raw.evidenceHash ?? raw[5],
      probeCommitment: raw.probeCommitment ?? raw[6],
    };
    if (attestation.attestedAt === 0) return null;
    return attestation;
  }

  async verificationStats(agentId: number | bigint, service: string): Promise<ServiceVerificationStats> {
    const raw = await this._contract().getFunction('verificationStats')(agentId, serviceHash(service));
    return decodeStats(raw);
  }

  /** Aggregate stats for an agent across every audited service. */
  async agentVerificationStats(agentId: number | bigint): Promise<ServiceVerificationStats> {
    const raw = await this._contract().getFunction('agentVerificationStats')(agentId);
    return decodeStats(raw);
  }

  async epochCredits(epoch: number, verifier: string): Promise<number> {
    const v = await this._contract().getFunction('epochCredits')(epoch, verifier);
    return Number(v);
  }

  async epochTotalCredits(epoch: number): Promise<number> {
    const v = await this._contract().getFunction('epochTotalCredits')(epoch);
    return Number(v);
  }

  async currentEpoch(): Promise<number> {
    const v = await this._contract().getFunction('currentEpoch')();
    return Number(v);
  }

  async getAuditPolicy(): Promise<{ auditCooldown: number; maxCreditsPerVerifierPerEpoch: number; minProbeCount: number }> {
    const contract = this._contract();
    const [cooldown, maxCredits, minProbes] = await Promise.all([
      contract.getFunction('auditCooldown')(),
      contract.getFunction('maxCreditsPerVerifierPerEpoch')(),
      contract.getFunction('minProbeCount')(),
    ]);
    return {
      auditCooldown: Number(cooldown),
      maxCreditsPerVerifierPerEpoch: Number(maxCredits),
      minProbeCount: Number(minProbes),
    };
  }
}

/** Client for AntseedVerifierRewards (emissions bucket claims). */
export class VerifierRewardsClient extends BaseEvmClient {
  constructor(config: VerifierRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    return new Contract(this._contractAddress, VERIFIER_REWARDS_ABI, this._provider);
  }

  async claimVerifierReward(signer: AbstractSigner, epoch: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'claimVerifierReward', epoch);
  }

  async claimDelegateReward(signer: AbstractSigner, epoch: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'claimDelegateReward', epoch);
  }

  async pendingDelegateReward(epoch: number, delegate: string): Promise<bigint> {
    return this._contract().getFunction('pendingDelegateReward')(epoch, delegate);
  }

  async delegateEpochPool(epoch: number): Promise<bigint> {
    return this._contract().getFunction('delegateEpochPool')(epoch);
  }

  async epochDelegateRewardClaimed(epoch: number, delegate: string): Promise<boolean> {
    return this._contract().getFunction('epochDelegateRewardClaimed')(epoch, delegate);
  }

  async settleEpochRemainder(signer: AbstractSigner, epoch: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'settleEpochRemainder', epoch);
  }

  async pendingVerifierReward(epoch: number, verifier: string): Promise<bigint> {
    return this._contract().getFunction('pendingVerifierReward')(epoch, verifier);
  }

  async verifierEpochBudget(epoch: number): Promise<bigint> {
    return this._contract().getFunction('verifierEpochBudget')(epoch);
  }

  async epochRewardClaimed(epoch: number, verifier: string): Promise<boolean> {
    return this._contract().getFunction('epochRewardClaimed')(epoch, verifier);
  }

  /** Gate epoch window: rewards are claimable for effectiveEpoch <= epoch < currentEpoch. */
  async getEpochWindow(): Promise<{ currentEpoch: number; effectiveEpoch: number }> {
    const gateAddress: string = await this._contract().getFunction('gate')();
    const gate = new Contract(gateAddress, EMISSIONS_GATE_MINI_ABI, this._provider);
    const [current, effective] = await Promise.all([
      gate.getFunction('currentEpoch')(),
      gate.getFunction('effectiveEpoch')(),
    ]);
    return { currentEpoch: Number(current), effectiveEpoch: Number(effective) };
  }
}
