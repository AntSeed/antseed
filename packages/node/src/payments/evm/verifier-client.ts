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
  verificationPointsPolicyAddress?: string;
  pointsPolicyRegistryAddress?: string;
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
  evidenceHash: string;
  evidenceUri: string;
  results: VerificationResultInput[];
}

export interface VerificationBundleSubmittedEvent {
  evidenceHash: string;
  verifier: string;
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
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface VerificationPolicyState {
  registered: boolean;
  minDistinctDiffVerifiers: number;
  diffPenaltyBps: number;
}

export const DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS = 2;
export const DEFAULT_DIFF_PENALTY_BPS = 10_000;

export const VERIFICATION_ABI = [
  'function setVerifier(address verifier, bool approved) external',
  'function submitVerificationBundle(bytes32 evidenceHash,string evidenceUri,(uint256 agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps)[] results) external',
  'function isVerificationSubmitted(bytes32 evidenceHash) external view returns (bool)',
  'function verificationBundle(bytes32 evidenceHash) external view returns ((address verifier,uint64 submittedAt,uint32 resultCount,string evidenceUri))',
  'function registry() external view returns (address)',
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function activeAgentDiffVerifierCount(uint256 agentId) external view returns (uint256)',
  'function activeServiceDiffVerifierCount(uint256 agentId,bytes32 serviceHash) external view returns (uint256)',
  'function latestVerifierVerdict(uint256 agentId,bytes32 serviceHash,address verifier) external view returns (uint8)',
  'function clearVerifierVerdict(uint256 agentId,bytes32 serviceHash,address verifier) external',
  'event VerificationBundleSubmitted(bytes32 indexed evidenceHash,address indexed verifier,uint32 resultCount,string evidenceUri)',
  'event VerificationResultSubmitted(bytes32 indexed evidenceHash,uint256 indexed agentId,bytes32 indexed serviceHash,uint8 verdict,uint16 modelShareBps)',
  'event VerifierVerdictTransitioned(uint256 indexed agentId,bytes32 indexed serviceHash,address indexed verifier,uint8 previousVerdict,uint8 newVerdict)',
  'event VerifierVerdictRemediated(uint256 indexed agentId,bytes32 indexed serviceHash,address indexed verifier,uint8 previousVerdict)',
] as const;

export const VERIFICATION_POINTS_POLICY_ABI = [
  'function penaltyCategory() external view returns (bytes32)',
  'function minDistinctDiffVerifiers() external view returns (uint256)',
  'function diffPenaltyBps() external view returns (uint16)',
  'function setMinDistinctDiffVerifiers(uint256 minimum) external',
  'function setDiffPenaltyBps(uint16 newPenaltyBps) external',
  'function verificationStatus() external view returns (address)',
] as const;

export const POINTS_POLICY_REGISTRY_ABI = [
  'function isPolicyRegistered(address policy) external view returns (bool)',
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
  private _verificationPointsPolicyInstance: Contract | null = null;
  private _pointsPolicyRegistryInstance: Contract | null = null;
  private readonly _verificationPointsPolicyAddress?: string;
  private readonly _pointsPolicyRegistryAddress?: string;

  constructor(config: VerifierClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._verificationPointsPolicyAddress = config.verificationPointsPolicyAddress
      ? getAddress(config.verificationPointsPolicyAddress)
      : undefined;
    this._pointsPolicyRegistryAddress = config.pointsPolicyRegistryAddress
      ? getAddress(config.pointsPolicyRegistryAddress)
      : undefined;
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFICATION_ABI, this._provider);
    return this._contractInstance;
  }

  private _verificationPointsPolicy(): Contract {
    if (!this._verificationPointsPolicyAddress) {
      throw new Error('verification points policy address is not configured');
    }
    this._verificationPointsPolicyInstance ??= new Contract(
      this._verificationPointsPolicyAddress,
      VERIFICATION_POINTS_POLICY_ABI,
      this._provider,
    );
    return this._verificationPointsPolicyInstance;
  }

  private _pointsPolicyRegistry(): Contract {
    if (!this._pointsPolicyRegistryAddress) {
      throw new Error('points policy registry address is not configured');
    }
    this._pointsPolicyRegistryInstance ??= new Contract(
      this._pointsPolicyRegistryAddress,
      POINTS_POLICY_REGISTRY_ABI,
      this._provider,
    );
    return this._pointsPolicyRegistryInstance;
  }

  async setVerifier(signer: AbstractSigner, verifier: string, approved: boolean): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'setVerifier', getAddress(verifier), approved);
  }

  async submitVerificationBundle(signer: AbstractSigner, input: SubmitVerificationBundleInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'submitVerificationBundle',
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

  async approvedVerifier(verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('approvedVerifiers')(getAddress(verifier)));
  }

  async activeAgentDiffVerifierCount(agentId: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('activeAgentDiffVerifierCount')(BigInt(agentId)));
  }

  async activeServiceDiffVerifierCount(agentId: number | bigint, targetServiceHash: string): Promise<bigint> {
    return BigInt(
      await this._contract().getFunction('activeServiceDiffVerifierCount')(BigInt(agentId), targetServiceHash),
    );
  }

  async latestVerifierVerdict(
    agentId: number | bigint,
    targetServiceHash: string,
    verifier: string,
  ): Promise<VerifierVerdict> {
    const verdict = Number(
      await this._contract().getFunction('latestVerifierVerdict')(
        BigInt(agentId),
        targetServiceHash,
        getAddress(verifier),
      ),
    );
    if (verdict < VERIFIER_VERDICT_UNKNOWN || verdict > VERIFIER_VERDICT_UNDETERMINED) {
      throw new Error(`verification contract returned invalid verdict: ${verdict}`);
    }
    return verdict as VerifierVerdict;
  }

  async clearVerifierVerdict(
    signer: AbstractSigner,
    agentId: number | bigint,
    targetServiceHash: string,
    verifier: string,
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'clearVerifierVerdict',
      BigInt(agentId),
      targetServiceHash,
      getAddress(verifier),
    );
  }

  async minDistinctDiffVerifiers(): Promise<number> {
    return Number(await this._verificationPointsPolicy().getFunction('minDistinctDiffVerifiers')());
  }

  async diffPenaltyBps(): Promise<number> {
    return Number(await this._verificationPointsPolicy().getFunction('diffPenaltyBps')());
  }

  async setMinDistinctDiffVerifiers(signer: AbstractSigner, minimum: number | bigint): Promise<string> {
    if (!this._verificationPointsPolicyAddress) {
      throw new Error('verification points policy address is not configured');
    }
    return this._execWriteAt(
      this._verificationPointsPolicyAddress,
      signer,
      VERIFICATION_POINTS_POLICY_ABI,
      'setMinDistinctDiffVerifiers',
      BigInt(minimum),
    );
  }

  async setDiffPenaltyBps(signer: AbstractSigner, penaltyBps: number): Promise<string> {
    if (!this._verificationPointsPolicyAddress) {
      throw new Error('verification points policy address is not configured');
    }
    return this._execWriteAt(
      this._verificationPointsPolicyAddress,
      signer,
      VERIFICATION_POINTS_POLICY_ABI,
      'setDiffPenaltyBps',
      penaltyBps,
    );
  }

  async verificationPolicyState(): Promise<VerificationPolicyState> {
    if (!this._verificationPointsPolicyAddress || !this._pointsPolicyRegistryAddress) {
      return {
        registered: false,
        minDistinctDiffVerifiers: DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS,
        diffPenaltyBps: DEFAULT_DIFF_PENALTY_BPS,
      };
    }
    const [registered, minDistinctDiffVerifiers, diffPenaltyBps] = await Promise.all([
      this._pointsPolicyRegistry()
        .getFunction('isPolicyRegistered')(this._verificationPointsPolicyAddress)
        .then(Boolean),
      this.minDistinctDiffVerifiers(),
      this.diffPenaltyBps(),
    ]);
    return { registered, minDistinctDiffVerifiers, diffPenaltyBps };
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
        resultCount: Number(log.args.resultCount ?? log.args[2]),
        evidenceUri: String(log.args.evidenceUri ?? log.args[3]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }
}
