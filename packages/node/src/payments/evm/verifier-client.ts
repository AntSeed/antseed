import {
  Contract,
  EventLog,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type AbstractSigner,
} from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface VerifierClientConfig {
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

export interface VerificationResultInput {
  agentId: number | bigint;
  serviceHash: string;
  verdict: Exclude<VerifierVerdict, typeof VERIFIER_VERDICT_UNKNOWN>;
  modelShareBps: number;
}

export interface SubmitVerificationBundleInput {
  expectedEpoch: number | bigint;
  /** Exact audit cost and credit weight in USD micros: $1 = 1_000_000, $1.20 = 1_200_000. */
  totalAuditCostUsdMicros: number | bigint;
  evidenceHash: string;
  evidenceUri: string;
  results: VerificationResultInput[];
}

export interface VerificationBundleSubmittedEvent {
  evidenceHash: string;
  verifier: string;
  epoch: bigint;
  totalAuditCostUsdMicros: bigint;
  awardedCreditUsdMicros: bigint;
  resultCount: number;
  evidenceUri: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface AttestationSubmittedEvent {
  auditId: string;
  verifier: string;
  agentId: bigint;
  serviceHash: string;
  verdict: VerifierVerdict;
  modelShareBps: number;
  evidenceHash: string;
  epoch: bigint;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export const VERIFICATION_ABI = [
  'function setVerifier(address verifier, bool approved) external',
  'function setMaxCreditUsdMicrosPerVerifierPerEpoch(uint64 maximum) external',
  'function submitVerificationBundle(uint256 expectedEpoch,uint64 totalAuditCostUsdMicros,bytes32 evidenceHash,string evidenceUri,(uint256 agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps)[] results) external',
  'function isVerificationSubmitted(bytes32 evidenceHash) external view returns (bool)',
  'function registry() external view returns (address)',
  'function emissionsGate() external view returns (address)',
  'function firstRewardedEpoch() external view returns (uint256)',
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function maxCreditUsdMicrosPerVerifierPerEpoch() external view returns (uint64)',
  'function epochCreditUsdMicros(uint256 epoch, address verifier) external view returns (uint256)',
  'function epochTotalCreditUsdMicros(uint256 epoch) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function agentPointsPenaltyBps(uint256 agentId) external view returns (uint16)',
  'function claimVerifierReward(uint256 epoch) external',
  'function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount,uint256 reserveAmount)',
  'function pendingVerifierReward(uint256 epoch,address verifier) external view returns (uint256)',
  'function verifierEpochBudget(uint256 epoch) external view returns (uint256)',
  'function verifierEpochTotalCreditUsdMicros(uint256 epoch) external view returns (uint256)',
  'function epochRemainderSettled(uint256 epoch) external view returns (bool)',
  'event VerificationBundleSubmitted(bytes32 indexed evidenceHash,address indexed verifier,uint256 indexed epoch,uint64 totalAuditCostUsdMicros,uint64 awardedCreditUsdMicros,uint32 resultCount,string evidenceUri)',
  'event VerificationResultSubmitted(bytes32 indexed evidenceHash,uint256 indexed agentId,bytes32 indexed serviceHash,uint8 verdict,uint16 modelShareBps)',
] as const;

const EMISSIONS_GATE_EPOCH_ABI = [
  'function GENESIS() external view returns (uint256)',
  'function EPOCH_DURATION() external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
] as const;

const ANTSEED_REGISTRY_ABI = [
  'function identityRegistry() external view returns (address)',
] as const;

const IDENTITY_REGISTRY_ABI = [
  'function ownerOf(uint256 agentId) external view returns (address)',
] as const;

export function serviceHash(service: string): string {
  return keccak256(toUtf8Bytes(service.trim().toLowerCase()));
}

export class VerifierClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;

  constructor(config: VerifierClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFICATION_ABI, this._provider);
    return this._contractInstance;
  }

  async setVerifier(signer: AbstractSigner, verifier: string, approved: boolean): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'setVerifier', getAddress(verifier), approved);
  }

  async setMaxCreditUsdMicrosPerVerifierPerEpoch(
    signer: AbstractSigner,
    maximum: number | bigint,
  ): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'setMaxCreditUsdMicrosPerVerifierPerEpoch', BigInt(maximum));
  }

  async submitVerificationBundle(signer: AbstractSigner, input: SubmitVerificationBundleInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'submitVerificationBundle',
      BigInt(input.expectedEpoch),
      BigInt(input.totalAuditCostUsdMicros),
      input.evidenceHash,
      input.evidenceUri,
      input.results.map((result) => ({
        agentId: BigInt(result.agentId),
        serviceHash: result.serviceHash,
        verdict: result.verdict,
        modelShareBps: result.modelShareBps,
      })),
    );
  }

  async isVerificationSubmitted(evidenceHash: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('isVerificationSubmitted')(evidenceHash));
  }

  async registry(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('registry')()));
  }

  async identityRegistry(): Promise<string> {
    const registry = new Contract(await this.registry(), ANTSEED_REGISTRY_ABI, this._provider);
    return getAddress(String(await registry.getFunction('identityRegistry')()));
  }

  async agentOwner(agentId: number | bigint): Promise<string> {
    const identityRegistry = new Contract(await this.identityRegistry(), IDENTITY_REGISTRY_ABI, this._provider);
    return getAddress(String(await identityRegistry.getFunction('ownerOf')(BigInt(agentId))));
  }

  async emissionsGate(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('emissionsGate')()));
  }

  async approvedVerifier(verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('approvedVerifiers')(getAddress(verifier)));
  }

  async maxCreditUsdMicrosPerVerifierPerEpoch(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('maxCreditUsdMicrosPerVerifierPerEpoch')());
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

  async epochCreditUsdMicros(epoch: number | bigint, verifier: string): Promise<bigint> {
    return BigInt(await this._contract().getFunction('epochCreditUsdMicros')(BigInt(epoch), getAddress(verifier)));
  }

  async epochTotalCreditUsdMicros(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('epochTotalCreditUsdMicros')(BigInt(epoch)));
  }

  async agentPointsPenaltyBps(agentId: number | bigint): Promise<number> {
    return Number(await this._contract().getFunction('agentPointsPenaltyBps')(BigInt(agentId)));
  }

  async claimVerifierReward(signer: AbstractSigner, epoch: number | bigint): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'claimVerifierReward', BigInt(epoch));
  }

  async settleEpochRemainder(signer: AbstractSigner, epoch: number | bigint): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'settleEpochRemainder', BigInt(epoch));
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

  async verifierEpochTotalCreditUsdMicros(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('verifierEpochTotalCreditUsdMicros')(BigInt(epoch)));
  }

  async epochRemainderSettled(epoch: number | bigint): Promise<boolean> {
    return Boolean(await this._contract().getFunction('epochRemainderSettled')(BigInt(epoch)));
  }

  async queryAttestations(
    agentId: number | bigint,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<AttestationSubmittedEvent[]> {
    const contract = this._contract();
    const resultFilterFactory = contract.filters.VerificationResultSubmitted;
    const bundleFilterFactory = contract.filters.VerificationBundleSubmitted;
    if (!resultFilterFactory || !bundleFilterFactory) {
      throw new Error('verification events are missing from verification ABI');
    }
    const [resultLogs, bundleLogs] = await Promise.all([
      contract.queryFilter(resultFilterFactory(null, BigInt(agentId), null), fromBlock, toBlock),
      contract.queryFilter(bundleFilterFactory(), fromBlock, toBlock),
    ]);
    const bundles = new Map(this._bundleEvents(bundleLogs).map((event) => [event.evidenceHash.toLowerCase(), event]));
    return resultLogs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      const evidenceHash = String(log.args.evidenceHash ?? log.args[0]);
      const bundle = bundles.get(evidenceHash.toLowerCase());
      if (!bundle) return [];
      return [{
        auditId: evidenceHash,
        verifier: bundle.verifier,
        agentId: BigInt(log.args.agentId ?? log.args[1]),
        serviceHash: String(log.args.serviceHash ?? log.args[2]),
        verdict: Number(log.args.verdict ?? log.args[3]) as VerifierVerdict,
        modelShareBps: Number(log.args.modelShareBps ?? log.args[4]),
        evidenceHash,
        epoch: bundle.epoch,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }

  async queryBundles(
    evidenceHash: string | null = null,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<VerificationBundleSubmittedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.VerificationBundleSubmitted;
    if (!filterFactory) throw new Error('VerificationBundleSubmitted event is missing from verification ABI');
    return this._bundleEvents(await contract.queryFilter(filterFactory(evidenceHash), fromBlock, toBlock));
  }

  private _bundleEvents(logs: readonly unknown[]): VerificationBundleSubmittedEvent[] {
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        evidenceHash: String(log.args.evidenceHash ?? log.args[0]),
        verifier: getAddress(String(log.args.verifier ?? log.args[1])),
        epoch: BigInt(log.args.epoch ?? log.args[2]),
        totalAuditCostUsdMicros: BigInt(log.args.totalAuditCostUsdMicros ?? log.args[3]),
        awardedCreditUsdMicros: BigInt(log.args.awardedCreditUsdMicros ?? log.args[4]),
        resultCount: Number(log.args.resultCount ?? log.args[5]),
        evidenceUri: String(log.args.evidenceUri ?? log.args[6]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }
}
