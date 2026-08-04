import {
  Contract,
  EventLog,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type AbstractSigner,
} from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface VerifierRegistryClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export type VerifierRewardsClientConfig = VerifierRegistryClientConfig;

export const VERIFIER_VERDICT_UNKNOWN = 0;
export const VERIFIER_VERDICT_SAME = 1;
export const VERIFIER_VERDICT_DIFF = 2;
export const VERIFIER_VERDICT_UNDETERMINED = 3;

export type VerifierVerdict =
  | typeof VERIFIER_VERDICT_UNKNOWN
  | typeof VERIFIER_VERDICT_SAME
  | typeof VERIFIER_VERDICT_DIFF
  | typeof VERIFIER_VERDICT_UNDETERMINED;

export interface MetricSnapshot {
  windowStartedAt: number;
  windowEndedAt: number;
  eligibleAttempts: number;
  successfulAttempts: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p50OutputTokensPerSecondMilli: number;
  schemaVersion: number;
  observationsRoot: string;
}

export interface AttestationState {
  auditId: string;
  verifier: string;
  agentId: bigint;
  serviceHash: string;
  verdict: VerifierVerdict;
  modelShareBps: number;
  probeCount: number;
  attestedAt: number;
  evidenceHash: string;
}

export interface ServiceVerificationStats {
  sameCount: number;
  diffCount: number;
  undeterminedCount: number;
  distinctVerifierCount: number;
  activeDiffVerifierCount: number;
  lastVerdict: VerifierVerdict;
  lastVerifier: string;
}

export interface SubmitVerificationResultInput {
  auditId: string;
  agentId: number | bigint;
  serviceHash: string;
  verdict: Exclude<VerifierVerdict, typeof VERIFIER_VERDICT_UNKNOWN>;
  expectedEpoch: number | bigint;
  modelShareBps: number;
  probeCount: number;
  metrics: MetricSnapshot;
  evidenceHash: string;
}

export interface AttestationSubmittedEvent {
  auditId: string;
  verifier: string;
  agentId: bigint;
  serviceHash: string;
  verdict: VerifierVerdict;
  modelShareBps: number;
  evidenceHash: string;
  probeCount: number;
  credited: boolean;
  epoch: bigint;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface MetricSnapshotSubmittedEvent extends MetricSnapshot {
  auditId: string;
  agentId: bigint;
  serviceHash: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export const VERIFIER_REGISTRY_ABI = [
  'function setVerifier(address verifier, bool approved) external',
  'function setAuditCooldown(uint64 cooldown) external',
  'function setMaxCreditsPerVerifierPerEpoch(uint32 maximum) external',
  'function setMinProbeCount(uint32 minimum) external',
  'function clearVerifierStanding(address verifier, uint256 agentId, bytes32 serviceHash) external',
  'function submitVerificationResult(bytes32 auditId, uint256 agentId, bytes32 serviceHash, uint8 verdict, uint256 expectedEpoch, uint16 modelShareBps, uint32 probeCount, (uint64 windowStartedAt,uint64 windowEndedAt,uint16 eligibleAttempts,uint16 successfulAttempts,uint32 p50TtftMs,uint32 p95TtftMs,uint32 p50OutputTokensPerSecondMilli,uint16 schemaVersion,bytes32 observationsRoot) metrics, bytes32 evidenceHash) external',
  'function publishEvidence(bytes32 auditId, string evidenceUri) external',
  'function registry() external view returns (address)',
  'function emissionsGate() external view returns (address)',
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function auditCooldown() external view returns (uint64)',
  'function maxCreditsPerVerifierPerEpoch() external view returns (uint32)',
  'function minProbeCount() external view returns (uint32)',
  'function getAttestation(bytes32 auditId) external view returns ((bytes32 auditId,address verifier,uint256 agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps,uint32 probeCount,uint64 attestedAt,bytes32 evidenceHash))',
  'function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns ((bytes32 auditId,address verifier,uint256 agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps,uint32 probeCount,uint64 attestedAt,bytes32 evidenceHash))',
  'function evidenceUris(bytes32 auditId) external view returns (string)',
  'function verificationStats(uint256 agentId, bytes32 serviceHash) external view returns ((uint32 sameCount,uint32 diffCount,uint32 undeterminedCount,uint32 distinctVerifierCount,uint32 activeDiffVerifierCount,uint8 lastVerdict,address lastVerifier))',
  'function agentVerificationStats(uint256 agentId) external view returns ((uint32 sameCount,uint32 diffCount,uint32 undeterminedCount,uint32 distinctVerifierCount,uint32 activeDiffVerifierCount,uint8 lastVerdict,address lastVerifier))',
  'function lastCreditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64)',
  'function epochCredits(uint256 epoch, address verifier) external view returns (uint256)',
  'function epochTotalCredits(uint256 epoch) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function servicePointsPenaltyBps(uint256 agentId, bytes32 serviceHash) external view returns (uint16)',
  'function agentPointsPenaltyBps(uint256 agentId) external view returns (uint256)',
  'event AttestationSubmitted(bytes32 indexed auditId,address indexed verifier,uint256 indexed agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps,bytes32 evidenceHash,uint32 probeCount,bool credited,uint256 epoch)',
  'event MetricSnapshotSubmitted(bytes32 indexed auditId,uint256 indexed agentId,bytes32 indexed serviceHash,uint64 windowStartedAt,uint64 windowEndedAt,uint16 eligibleAttempts,uint16 successfulAttempts,uint32 p50TtftMs,uint32 p95TtftMs,uint32 p50OutputTokensPerSecondMilli,uint16 schemaVersion,bytes32 observationsRoot)',
  'event EvidencePublished(bytes32 indexed auditId,string evidenceUri)',
] as const;

export const VERIFIER_REWARDS_ABI = [
  'function claimVerifierReward(uint256 epoch) external',
  'function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount,uint256 reserveAmount)',
  'function gate() external view returns (address)',
  'function verifierRegistry() external view returns (address)',
  'function firstRewardedEpoch() external view returns (uint256)',
  'function pendingVerifierReward(uint256 epoch,address verifier) external view returns (uint256)',
  'function verifierEpochBudget(uint256 epoch) external view returns (uint256)',
  'function verifierEpochTotalCredits(uint256 epoch) external view returns (uint256)',
  'function epochRewardClaimed(uint256 epoch,address verifier) external view returns (bool)',
  'function epochRemainderSettled(uint256 epoch) external view returns (bool)',
] as const;

const EMISSIONS_GATE_EPOCH_ABI = [
  'function GENESIS() external view returns (uint256)',
  'function EPOCH_DURATION() external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
] as const;

export function serviceHash(service: string): string {
  return keccak256(toUtf8Bytes(service.trim().toLowerCase()));
}

export class VerifierRegistryClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;

  constructor(config: VerifierRegistryClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFIER_REGISTRY_ABI, this._provider);
    return this._contractInstance;
  }

  async setVerifier(signer: AbstractSigner, verifier: string, approved: boolean): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'setVerifier', getAddress(verifier), approved);
  }

  async setAuditCooldown(signer: AbstractSigner, cooldownSeconds: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'setAuditCooldown', cooldownSeconds);
  }

  async setMaxCreditsPerVerifierPerEpoch(signer: AbstractSigner, maximum: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'setMaxCreditsPerVerifierPerEpoch', maximum);
  }

  async setMinProbeCount(signer: AbstractSigner, minimum: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'setMinProbeCount', minimum);
  }

  async clearVerifierStanding(
    signer: AbstractSigner,
    verifier: string,
    agentId: number | bigint,
    targetServiceHash: string,
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'clearVerifierStanding',
      getAddress(verifier),
      BigInt(agentId),
      targetServiceHash,
    );
  }

  async submitVerificationResult(signer: AbstractSigner, input: SubmitVerificationResultInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'submitVerificationResult',
      input.auditId,
      BigInt(input.agentId),
      input.serviceHash,
      input.verdict,
      BigInt(input.expectedEpoch),
      input.modelShareBps,
      input.probeCount,
      tupleMetrics(input.metrics),
      input.evidenceHash,
    );
  }

  async publishEvidence(signer: AbstractSigner, auditId: string, evidenceUri: string): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'publishEvidence', auditId, evidenceUri);
  }

  async registry(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('registry')()));
  }

  async emissionsGate(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('emissionsGate')()));
  }

  async approvedVerifier(verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('approvedVerifiers')(getAddress(verifier)));
  }

  async auditCooldown(): Promise<number> {
    return Number(await this._contract().getFunction('auditCooldown')());
  }

  async maxCreditsPerVerifierPerEpoch(): Promise<number> {
    return Number(await this._contract().getFunction('maxCreditsPerVerifierPerEpoch')());
  }

  async minProbeCount(): Promise<number> {
    return Number(await this._contract().getFunction('minProbeCount')());
  }

  async currentEpoch(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('currentEpoch')());
  }

  async currentEpochWindow(): Promise<{ epoch: bigint; startedAt: number; endsAt: number }> {
    const gateAddress = await this.emissionsGate();
    const gate = new Contract(gateAddress, EMISSIONS_GATE_EPOCH_ABI, this._provider);
    const [genesisValue, durationValue, epochValue] = await Promise.all([
      gate.getFunction('GENESIS')(),
      gate.getFunction('EPOCH_DURATION')(),
      gate.getFunction('currentEpoch')(),
    ]);
    const genesis = BigInt(genesisValue);
    const duration = BigInt(durationValue);
    const epoch = BigInt(epochValue);
    const startedAt = genesis + epoch * duration;
    const endsAt = startedAt + duration;
    if (startedAt > BigInt(Number.MAX_SAFE_INTEGER) || endsAt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('epoch window exceeds safe integer range');
    }
    return { epoch, startedAt: Number(startedAt), endsAt: Number(endsAt) };
  }

  async getAttestation(auditId: string): Promise<AttestationState> {
    return decodeAttestation(await this._contract().getFunction('getAttestation')(auditId));
  }

  async latestAttestation(agentId: number | bigint, targetServiceHash: string): Promise<AttestationState> {
    return decodeAttestation(
      await this._contract().getFunction('latestAttestation')(BigInt(agentId), targetServiceHash),
    );
  }

  async evidenceUri(auditId: string): Promise<string> {
    return String(await this._contract().getFunction('evidenceUris')(auditId));
  }

  async verificationStats(agentId: number | bigint, targetServiceHash: string): Promise<ServiceVerificationStats> {
    return decodeStats(
      await this._contract().getFunction('verificationStats')(BigInt(agentId), targetServiceHash),
    );
  }

  async agentVerificationStats(agentId: number | bigint): Promise<ServiceVerificationStats> {
    return decodeStats(await this._contract().getFunction('agentVerificationStats')(BigInt(agentId)));
  }

  async lastCreditedAt(agentId: number | bigint, targetServiceHash: string): Promise<number> {
    return Number(await this._contract().getFunction('lastCreditedAt')(BigInt(agentId), targetServiceHash));
  }

  async epochCredits(epoch: number | bigint, verifier: string): Promise<bigint> {
    return BigInt(await this._contract().getFunction('epochCredits')(BigInt(epoch), getAddress(verifier)));
  }

  async epochTotalCredits(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('epochTotalCredits')(BigInt(epoch)));
  }

  async servicePointsPenaltyBps(agentId: number | bigint, targetServiceHash: string): Promise<number> {
    return Number(
      await this._contract().getFunction('servicePointsPenaltyBps')(BigInt(agentId), targetServiceHash),
    );
  }

  async agentPointsPenaltyBps(agentId: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('agentPointsPenaltyBps')(BigInt(agentId)));
  }

  async queryAttestations(
    agentId: number | bigint,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<AttestationSubmittedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.AttestationSubmitted;
    if (!filterFactory) throw new Error('AttestationSubmitted event is missing from verifier registry ABI');
    const logs = await contract.queryFilter(filterFactory(null, null, BigInt(agentId)), fromBlock, toBlock);
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        auditId: String(log.args.auditId ?? log.args[0]),
        verifier: getAddress(String(log.args.verifier ?? log.args[1])),
        agentId: BigInt(log.args.agentId ?? log.args[2]),
        serviceHash: String(log.args.serviceHash ?? log.args[3]),
        verdict: Number(log.args.verdict ?? log.args[4]) as VerifierVerdict,
        modelShareBps: Number(log.args.modelShareBps ?? log.args[5]),
        evidenceHash: String(log.args.evidenceHash ?? log.args[6]),
        probeCount: Number(log.args.probeCount ?? log.args[7]),
        credited: Boolean(log.args.credited ?? log.args[8]),
        epoch: BigInt(log.args.epoch ?? log.args[9]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }

  async queryMetricSnapshots(
    agentId: number | bigint,
    targetServiceHash?: string,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<MetricSnapshotSubmittedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.MetricSnapshotSubmitted;
    if (!filterFactory) throw new Error('MetricSnapshotSubmitted event is missing from verifier registry ABI');
    const logs = await contract.queryFilter(
      filterFactory(null, BigInt(agentId), targetServiceHash ?? null),
      fromBlock,
      toBlock,
    );
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        auditId: String(log.args.auditId ?? log.args[0]),
        agentId: BigInt(log.args.agentId ?? log.args[1]),
        serviceHash: String(log.args.serviceHash ?? log.args[2]),
        windowStartedAt: Number(log.args.windowStartedAt ?? log.args[3]),
        windowEndedAt: Number(log.args.windowEndedAt ?? log.args[4]),
        eligibleAttempts: Number(log.args.eligibleAttempts ?? log.args[5]),
        successfulAttempts: Number(log.args.successfulAttempts ?? log.args[6]),
        p50TtftMs: Number(log.args.p50TtftMs ?? log.args[7]),
        p95TtftMs: Number(log.args.p95TtftMs ?? log.args[8]),
        p50OutputTokensPerSecondMilli: Number(log.args.p50OutputTokensPerSecondMilli ?? log.args[9]),
        schemaVersion: Number(log.args.schemaVersion ?? log.args[10]),
        observationsRoot: String(log.args.observationsRoot ?? log.args[11]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }
}

export class VerifierRewardsClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;

  constructor(config: VerifierRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFIER_REWARDS_ABI, this._provider);
    return this._contractInstance;
  }

  async claimVerifierReward(signer: AbstractSigner, epoch: number | bigint): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'claimVerifierReward', BigInt(epoch));
  }

  async settleEpochRemainder(signer: AbstractSigner, epoch: number | bigint): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'settleEpochRemainder', BigInt(epoch));
  }

  async gate(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('gate')()));
  }

  async verifierRegistry(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('verifierRegistry')()));
  }

  async firstRewardedEpoch(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('firstRewardedEpoch')());
  }

  async pendingVerifierReward(epoch: number | bigint, verifier: string): Promise<bigint> {
    return BigInt(
      await this._contract().getFunction('pendingVerifierReward')(BigInt(epoch), getAddress(verifier)),
    );
  }

  async verifierEpochBudget(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('verifierEpochBudget')(BigInt(epoch)));
  }

  async verifierEpochTotalCredits(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('verifierEpochTotalCredits')(BigInt(epoch)));
  }

  async epochRewardClaimed(epoch: number | bigint, verifier: string): Promise<boolean> {
    return Boolean(
      await this._contract().getFunction('epochRewardClaimed')(BigInt(epoch), getAddress(verifier)),
    );
  }

  async epochRemainderSettled(epoch: number | bigint): Promise<boolean> {
    return Boolean(await this._contract().getFunction('epochRemainderSettled')(BigInt(epoch)));
  }
}

function tupleMetrics(metrics: MetricSnapshot): readonly unknown[] {
  return [
    metrics.windowStartedAt,
    metrics.windowEndedAt,
    metrics.eligibleAttempts,
    metrics.successfulAttempts,
    metrics.p50TtftMs,
    metrics.p95TtftMs,
    metrics.p50OutputTokensPerSecondMilli,
    metrics.schemaVersion,
    metrics.observationsRoot,
  ];
}

function decodeAttestation(raw: Record<string | number, unknown> & unknown[]): AttestationState {
  return {
    auditId: String(raw.auditId ?? raw[0]),
    verifier: getAddress(String(raw.verifier ?? raw[1])),
    agentId: BigInt(raw.agentId as bigint ?? raw[2] as bigint),
    serviceHash: String(raw.serviceHash ?? raw[3]),
    verdict: Number(raw.verdict ?? raw[4]) as VerifierVerdict,
    modelShareBps: Number(raw.modelShareBps ?? raw[5]),
    probeCount: Number(raw.probeCount ?? raw[6]),
    attestedAt: Number(raw.attestedAt ?? raw[7]),
    evidenceHash: String(raw.evidenceHash ?? raw[8]),
  };
}

function decodeStats(raw: Record<string | number, unknown> & unknown[]): ServiceVerificationStats {
  return {
    sameCount: Number(raw.sameCount ?? raw[0]),
    diffCount: Number(raw.diffCount ?? raw[1]),
    undeterminedCount: Number(raw.undeterminedCount ?? raw[2]),
    distinctVerifierCount: Number(raw.distinctVerifierCount ?? raw[3]),
    activeDiffVerifierCount: Number(raw.activeDiffVerifierCount ?? raw[4]),
    lastVerdict: Number(raw.lastVerdict ?? raw[5]) as VerifierVerdict,
    lastVerifier: getAddress(String(raw.lastVerifier ?? raw[6])),
  };
}
