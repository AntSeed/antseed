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

export const VERIFIER_VERDICT_UNKNOWN = 0;
export const VERIFIER_VERDICT_SAME = 1;
export const VERIFIER_VERDICT_DIFF = 2;
export const VERIFIER_VERDICT_UNDETERMINED = 3;

export type VerifierVerdict =
  | typeof VERIFIER_VERDICT_UNKNOWN
  | typeof VERIFIER_VERDICT_SAME
  | typeof VERIFIER_VERDICT_DIFF
  | typeof VERIFIER_VERDICT_UNDETERMINED;

export interface AuditJob {
  auditId: string;
  jobIndex: number;
  sellerPeerId: string;
  serviceHash: string;
  requestHash: string;
  jobSalt: string;
  executeAfter: number;
  executeBefore: number;
}

export interface RelayAssignment {
  auditId: string;
  jobIndex: number;
  attempt: number;
  relayBuyer: string;
  payoutPerJobUsdc: bigint;
  executeAfter: number;
  executeBefore: number;
}

export interface RelayClaim {
  job: AuditJob;
  jobProof: string[];
  assignment: RelayAssignment;
  verifierSignature: string;
  responseAuthPayload: string;
}

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

export interface AuditState {
  committer: string;
  targetCommitment: string;
  probeRoot: string;
  auditJobRoot: string;
  referenceId: string;
  verifierConfigHash: string;
  commitSequence: bigint;
  probeCount: number;
  jobCount: number;
  payoutPerJobUsdc: bigint;
  reservedRelayBudgetUsdc: bigint;
  totalRelayPaidUsdc: bigint;
  committedAt: number;
  executeAfter: number;
  executeBefore: number;
  forceClaimAvailableAt: number;
  forceClaimDeadline: number;
  attestedAt: number;
  attested: boolean;
  evidenceHash: string;
  evidenceUri: string;
}

export interface AttestationState {
  auditId: string;
  verifier: string;
  agentId: bigint;
  serviceHash: string;
  verdict: VerifierVerdict;
  modelShareBps: number;
  attestedAt: number;
  evidenceHash: string;
}

export interface ParsedResponseAuth {
  buyer: string;
  seller: string;
  advertisedServiceHash: string;
  statusCode: number;
  requestHash: string;
  responseHash: string;
  responseStartedAt: number;
  responseCompletedAt: number;
}

export interface CommitProbesInput {
  auditId: string;
  targetCommitment: string;
  probeRoot: string;
  auditJobRoot: string;
  referenceId: string;
  verifierConfigHash: string;
  probeCount: number;
  jobCount: number;
  payoutPerJobUsdc: bigint;
}

export interface SubmitAttestationInput {
  auditId: string;
  agentId: number | bigint;
  serviceHash: string;
  targetSalt: string;
  verdict: Exclude<VerifierVerdict, typeof VERIFIER_VERDICT_UNKNOWN>;
  modelShareBps: number;
  metrics: MetricSnapshot;
  evidenceHash: string;
  evidenceUri: string;
  relayClaims: RelayClaim[];
}

export interface AttestationSubmittedEvent {
  auditId: string;
  verifier: string;
  agentId: bigint;
  serviceHash: string;
  verdict: VerifierVerdict;
  modelShareBps: number;
  evidenceHash: string;
  relayClaimCount: number;
  relayPayoutUsdc: bigint;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export const VERIFIER_REGISTRY_ABI = [
  'function commitProbes(bytes32 auditId, bytes32 targetCommitment, bytes32 probeRoot, bytes32 auditJobRoot, bytes32 referenceId, bytes32 verifierConfigHash, uint32 probeCount, uint16 jobCount, uint96 payoutPerJobUsdc) external',
  'function submitAttestation(bytes32 auditId, uint256 agentId, bytes32 serviceHash, bytes32 targetSalt, uint8 verdict, uint16 modelShareBps, (uint64 windowStartedAt,uint64 windowEndedAt,uint16 eligibleAttempts,uint16 successfulAttempts,uint32 p50TtftMs,uint32 p95TtftMs,uint32 p50OutputTokensPerSecondMilli,uint16 schemaVersion,bytes32 observationsRoot) metrics, bytes32 evidenceHash, string evidenceUri, ((bytes32 auditId,uint16 jobIndex,address sellerPeerId,bytes32 serviceHash,bytes32 requestHash,bytes32 jobSalt,uint64 executeAfter,uint64 executeBefore) job,bytes32[] jobProof,(bytes32 auditId,uint16 jobIndex,uint8 attempt,address relayBuyer,uint96 payoutPerJobUsdc,uint64 executeAfter,uint64 executeBefore) assignment,bytes verifierSignature,bytes responseAuthPayload)[] relayClaims) external',
  'function forceClaimRelayJob(bytes32 auditId, ((bytes32 auditId,uint16 jobIndex,address sellerPeerId,bytes32 serviceHash,bytes32 requestHash,bytes32 jobSalt,uint64 executeAfter,uint64 executeBefore) job,bytes32[] jobProof,(bytes32 auditId,uint16 jobIndex,uint8 attempt,address relayBuyer,uint96 payoutPerJobUsdc,uint64 executeAfter,uint64 executeBefore) assignment,bytes verifierSignature,bytes responseAuthPayload) relayClaim) external',
  'function publishEvidence(bytes32 auditId, string evidenceUri) external',
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function emissionsGate() external view returns (address)',
  'function relayTreasury() external view returns (address)',
  'function relayJobPaidBitmap(bytes32 auditId) external view returns (uint256)',
  'function paidRequestHashes(bytes32 requestHash) external view returns (bytes32)',
  'function getAudit(bytes32 auditId) external view returns ((address committer,bytes32 targetCommitment,bytes32 probeRoot,bytes32 auditJobRoot,bytes32 referenceId,bytes32 verifierConfigHash,uint256 commitSequence,uint32 probeCount,uint16 jobCount,uint96 payoutPerJobUsdc,uint96 reservedRelayBudgetUsdc,uint96 totalRelayPaidUsdc,uint64 committedAt,uint64 executeAfter,uint64 executeBefore,uint64 forceClaimAvailableAt,uint64 forceClaimDeadline,uint64 attestedAt,bool attested,bytes32 evidenceHash,string evidenceUri))',
  'function getAttestation(bytes32 auditId) external view returns ((bytes32 auditId,address verifier,uint256 agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps,uint64 attestedAt,bytes32 evidenceHash))',
  'function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns ((bytes32 auditId,address verifier,uint256 agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps,uint64 attestedAt,bytes32 evidenceHash))',
  'function lastAcceptedAuditSequence(uint256 agentId, bytes32 serviceHash) external view returns (uint256)',
  'function agentPointsPenaltyBps(uint256 agentId) external view returns (uint16)',
  'function hashAuditTarget(uint256 agentId, bytes32 serviceHash, bytes32 targetSalt) external view returns (bytes32)',
  'function hashAuditJob((bytes32 auditId,uint16 jobIndex,address sellerPeerId,bytes32 serviceHash,bytes32 requestHash,bytes32 jobSalt,uint64 executeAfter,uint64 executeBefore) job) external view returns (bytes32)',
  'function hashRelayAssignment((bytes32 auditId,uint16 jobIndex,uint8 attempt,address relayBuyer,uint96 payoutPerJobUsdc,uint64 executeAfter,uint64 executeBefore) assignment) external view returns (bytes32)',
  'function verifyAuditJobProof(bytes32 root, bytes32 leaf, uint16 jobIndex, uint16 jobCount, bytes32[] proof) external pure returns (bool)',
  'function hashNormalizedService(string advertisedService) external pure returns (bytes32)',
  'function responseAuthDigest(bytes signingPayload) external pure returns (bytes32)',
  'function parseResponseAuthPayload(bytes payload) external pure returns (address buyer,address seller,bytes32 advertisedServiceHash,uint16 statusCode,bytes32 requestHash,bytes32 responseHash,uint64 responseStartedAt,uint64 responseCompletedAt)',
  'function isRelayJobPaid(bytes32 auditId, uint16 jobIndex) external view returns (bool)',
  'function requiredRelayCount(uint16 jobCount) external pure returns (uint16)',
  'event AttestationSubmitted(bytes32 indexed auditId,address indexed verifier,uint256 indexed agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps,bytes32 evidenceHash,uint256 relayClaimCount,uint96 relayPayoutUsdc)',
] as const;

function tupleJob(job: AuditJob): readonly unknown[] {
  return [
    job.auditId,
    job.jobIndex,
    getAddress(job.sellerPeerId),
    job.serviceHash,
    job.requestHash,
    job.jobSalt,
    job.executeAfter,
    job.executeBefore,
  ];
}

function tupleAssignment(assignment: RelayAssignment): readonly unknown[] {
  return [
    assignment.auditId,
    assignment.jobIndex,
    assignment.attempt,
    getAddress(assignment.relayBuyer),
    assignment.payoutPerJobUsdc,
    assignment.executeAfter,
    assignment.executeBefore,
  ];
}

function tupleClaim(claim: RelayClaim): readonly unknown[] {
  return [
    tupleJob(claim.job),
    claim.jobProof,
    tupleAssignment(claim.assignment),
    claim.verifierSignature,
    claim.responseAuthPayload,
  ];
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

function decodeAudit(raw: Record<string | number, unknown> & unknown[]): AuditState {
  return {
    committer: getAddress(String(raw.committer ?? raw[0])),
    targetCommitment: String(raw.targetCommitment ?? raw[1]),
    probeRoot: String(raw.probeRoot ?? raw[2]),
    auditJobRoot: String(raw.auditJobRoot ?? raw[3]),
    referenceId: String(raw.referenceId ?? raw[4]),
    verifierConfigHash: String(raw.verifierConfigHash ?? raw[5]),
    commitSequence: BigInt(raw.commitSequence as bigint ?? raw[6] as bigint),
    probeCount: Number(raw.probeCount ?? raw[7]),
    jobCount: Number(raw.jobCount ?? raw[8]),
    payoutPerJobUsdc: BigInt(raw.payoutPerJobUsdc as bigint ?? raw[9] as bigint),
    reservedRelayBudgetUsdc: BigInt(raw.reservedRelayBudgetUsdc as bigint ?? raw[10] as bigint),
    totalRelayPaidUsdc: BigInt(raw.totalRelayPaidUsdc as bigint ?? raw[11] as bigint),
    committedAt: Number(raw.committedAt ?? raw[12]),
    executeAfter: Number(raw.executeAfter ?? raw[13]),
    executeBefore: Number(raw.executeBefore ?? raw[14]),
    forceClaimAvailableAt: Number(raw.forceClaimAvailableAt ?? raw[15]),
    forceClaimDeadline: Number(raw.forceClaimDeadline ?? raw[16]),
    attestedAt: Number(raw.attestedAt ?? raw[17]),
    attested: Boolean(raw.attested ?? raw[18]),
    evidenceHash: String(raw.evidenceHash ?? raw[19]),
    evidenceUri: String(raw.evidenceUri ?? raw[20]),
  };
}

function decodeAttestation(raw: Record<string | number, unknown> & unknown[]): AttestationState {
  return {
    auditId: String(raw.auditId ?? raw[0]),
    verifier: getAddress(String(raw.verifier ?? raw[1])),
    agentId: BigInt(raw.agentId as bigint ?? raw[2] as bigint),
    serviceHash: String(raw.serviceHash ?? raw[3]),
    verdict: Number(raw.verdict ?? raw[4]) as VerifierVerdict,
    modelShareBps: Number(raw.modelShareBps ?? raw[5]),
    attestedAt: Number(raw.attestedAt ?? raw[6]),
    evidenceHash: String(raw.evidenceHash ?? raw[7]),
  };
}

export function serviceHash(service: string): string {
  const normalized = service.trim().toLowerCase();
  if (normalized.length === 0) throw new Error('service must not be empty');
  return keccak256(toUtf8Bytes(normalized));
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

  async commitProbes(signer: AbstractSigner, input: CommitProbesInput): Promise<string> {
    return this._execWrite(
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
  }

  async submitAttestation(signer: AbstractSigner, input: SubmitAttestationInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'submitAttestation',
      input.auditId,
      BigInt(input.agentId),
      input.serviceHash,
      input.targetSalt,
      input.verdict,
      input.modelShareBps,
      tupleMetrics(input.metrics),
      input.evidenceHash,
      input.evidenceUri,
      input.relayClaims.map(tupleClaim),
    );
  }

  async simulateSubmitAttestation(signer: AbstractSigner, input: SubmitAttestationInput): Promise<void> {
    const connected = this._ensureConnected(signer);
    const contract = new Contract(this._contractAddress, VERIFIER_REGISTRY_ABI, connected);
    await contract.getFunction('submitAttestation').staticCall(
      input.auditId,
      BigInt(input.agentId),
      input.serviceHash,
      input.targetSalt,
      input.verdict,
      input.modelShareBps,
      tupleMetrics(input.metrics),
      input.evidenceHash,
      input.evidenceUri,
      input.relayClaims.map(tupleClaim),
    );
  }

  async estimateSubmitAttestationGas(signer: AbstractSigner, input: SubmitAttestationInput): Promise<bigint> {
    const connected = this._ensureConnected(signer);
    const contract = new Contract(this._contractAddress, VERIFIER_REGISTRY_ABI, connected);
    return contract.getFunction('submitAttestation').estimateGas(
      input.auditId,
      BigInt(input.agentId),
      input.serviceHash,
      input.targetSalt,
      input.verdict,
      input.modelShareBps,
      tupleMetrics(input.metrics),
      input.evidenceHash,
      input.evidenceUri,
      input.relayClaims.map(tupleClaim),
    );
  }

  async forceClaimRelayJob(signer: AbstractSigner, auditId: string, relayClaim: RelayClaim): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'forceClaimRelayJob', auditId, tupleClaim(relayClaim));
  }

  async publishEvidence(signer: AbstractSigner, auditId: string, evidenceUri: string): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'publishEvidence', auditId, evidenceUri);
  }

  async isApprovedVerifier(verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('approvedVerifiers')(getAddress(verifier)));
  }

  async relayTreasury(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('relayTreasury')()));
  }

  async currentEpochWindow(): Promise<{ epoch: bigint; startedAt: number; endsAt: number }> {
    const gateAddress = getAddress(String(await this._contract().getFunction('emissionsGate')()));
    const gate = new Contract(gateAddress, [
      'function GENESIS() external view returns (uint256)',
      'function EPOCH_DURATION() external view returns (uint256)',
      'function currentEpoch() external view returns (uint256)',
    ], this._provider);
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

  async getAudit(auditId: string): Promise<AuditState> {
    return decodeAudit(await this._contract().getFunction('getAudit')(auditId));
  }

  async getAttestation(auditId: string): Promise<AttestationState> {
    return decodeAttestation(await this._contract().getFunction('getAttestation')(auditId));
  }

  async latestAttestation(agentId: number | bigint, targetServiceHash: string): Promise<AttestationState> {
    return decodeAttestation(
      await this._contract().getFunction('latestAttestation')(BigInt(agentId), targetServiceHash),
    );
  }

  async lastAcceptedAuditSequence(agentId: number | bigint, targetServiceHash: string): Promise<bigint> {
    return BigInt(
      await this._contract().getFunction('lastAcceptedAuditSequence')(BigInt(agentId), targetServiceHash),
    );
  }

  async agentPointsPenaltyBps(agentId: number | bigint): Promise<number> {
    return Number(await this._contract().getFunction('agentPointsPenaltyBps')(BigInt(agentId)));
  }

  async relayJobPaidBitmap(auditId: string): Promise<bigint> {
    return BigInt(await this._contract().getFunction('relayJobPaidBitmap')(auditId));
  }

  async paidRequestHash(requestHash: string): Promise<string> {
    return String(await this._contract().getFunction('paidRequestHashes')(requestHash));
  }

  async hashAuditTarget(agentId: number | bigint, targetServiceHash: string, targetSalt: string): Promise<string> {
    return String(
      await this._contract().getFunction('hashAuditTarget')(BigInt(agentId), targetServiceHash, targetSalt),
    );
  }

  async hashAuditJob(job: AuditJob): Promise<string> {
    return String(await this._contract().getFunction('hashAuditJob')(tupleJob(job)));
  }

  async hashRelayAssignment(assignment: RelayAssignment): Promise<string> {
    return String(await this._contract().getFunction('hashRelayAssignment')(tupleAssignment(assignment)));
  }

  async signRelayAssignment(signer: AbstractSigner, assignment: RelayAssignment): Promise<string> {
    const network = await this._provider.getNetwork();
    return signer.signTypedData(
      {
        name: 'AntseedVerifierRegistry',
        version: '1',
        chainId: network.chainId,
        verifyingContract: this._contractAddress,
      },
      {
        RelayAssignment: [
          { name: 'auditId', type: 'bytes32' },
          { name: 'jobIndex', type: 'uint16' },
          { name: 'attempt', type: 'uint8' },
          { name: 'relayBuyer', type: 'address' },
          { name: 'payoutPerJobUsdc', type: 'uint96' },
          { name: 'executeAfter', type: 'uint64' },
          { name: 'executeBefore', type: 'uint64' },
        ],
      },
      {
        ...assignment,
        relayBuyer: getAddress(assignment.relayBuyer),
      },
    );
  }

  async verifyAuditJobProof(
    root: string,
    leaf: string,
    jobIndex: number,
    jobCount: number,
    proof: string[],
  ): Promise<boolean> {
    return Boolean(
      await this._contract().getFunction('verifyAuditJobProof')(root, leaf, jobIndex, jobCount, proof),
    );
  }

  async hashNormalizedService(advertisedService: string): Promise<string> {
    return String(await this._contract().getFunction('hashNormalizedService')(advertisedService));
  }

  async responseAuthDigest(signingPayload: string): Promise<string> {
    return String(await this._contract().getFunction('responseAuthDigest')(signingPayload));
  }

  async parseResponseAuthPayload(payload: string): Promise<ParsedResponseAuth> {
    const raw = await this._contract().getFunction('parseResponseAuthPayload')(payload) as Record<string | number, unknown> & unknown[];
    return {
      buyer: getAddress(String(raw.buyer ?? raw[0])),
      seller: getAddress(String(raw.seller ?? raw[1])),
      advertisedServiceHash: String(raw.advertisedServiceHash ?? raw[2]),
      statusCode: Number(raw.statusCode ?? raw[3]),
      requestHash: String(raw.requestHash ?? raw[4]),
      responseHash: String(raw.responseHash ?? raw[5]),
      responseStartedAt: Number(raw.responseStartedAt ?? raw[6]),
      responseCompletedAt: Number(raw.responseCompletedAt ?? raw[7]),
    };
  }

  async isRelayJobPaid(auditId: string, jobIndex: number): Promise<boolean> {
    return Boolean(await this._contract().getFunction('isRelayJobPaid')(auditId, jobIndex));
  }

  async requiredRelayCount(jobCount: number): Promise<number> {
    return Number(await this._contract().getFunction('requiredRelayCount')(jobCount));
  }

  async queryAttestations(
    agentId: number | bigint,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<AttestationSubmittedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.AttestationSubmitted;
    if (!filterFactory) throw new Error('AttestationSubmitted event is missing from verifier registry ABI');
    const filter = filterFactory(null, null, BigInt(agentId));
    const logs = await contract.queryFilter(filter, fromBlock, toBlock);
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
        relayClaimCount: Number(log.args.relayClaimCount ?? log.args[7]),
        relayPayoutUsdc: BigInt(log.args.relayPayoutUsdc ?? log.args[8]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }
}
