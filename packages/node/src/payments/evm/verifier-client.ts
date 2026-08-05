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

export interface SubmitVerificationResultInput {
  auditId: string;
  agentId: number | bigint;
  serviceHash: string;
  verdict: Exclude<VerifierVerdict, typeof VERIFIER_VERDICT_UNKNOWN>;
  expectedEpoch: number | bigint;
  modelShareBps: number;
  probeCount: number;
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

export const VERIFICATION_ABI = [
  'function setVerifier(address verifier, bool approved) external',
  'function setMaxCreditsPerVerifierPerEpoch(uint32 maximum) external',
  'function submitVerificationResult(bytes32 auditId, uint256 agentId, bytes32 serviceHash, uint8 verdict, uint256 expectedEpoch, uint16 modelShareBps, uint32 probeCount, bytes32 evidenceHash) external',
  'function registry() external view returns (address)',
  'function emissionsGate() external view returns (address)',
  'function firstRewardedEpoch() external view returns (uint256)',
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function maxCreditsPerVerifierPerEpoch() external view returns (uint32)',
  'function epochCredits(uint256 epoch, address verifier) external view returns (uint256)',
  'function epochTotalCredits(uint256 epoch) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function agentPointsPenaltyBps(uint256 agentId) external view returns (uint16)',
  'function claimVerifierReward(uint256 epoch) external',
  'function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount,uint256 reserveAmount)',
  'function pendingVerifierReward(uint256 epoch,address verifier) external view returns (uint256)',
  'function verifierEpochBudget(uint256 epoch) external view returns (uint256)',
  'function verifierEpochTotalCredits(uint256 epoch) external view returns (uint256)',
  'function epochRemainderSettled(uint256 epoch) external view returns (bool)',
  'event AttestationSubmitted(bytes32 indexed auditId,address indexed verifier,uint256 indexed agentId,bytes32 serviceHash,uint8 verdict,uint16 modelShareBps,bytes32 evidenceHash,uint32 probeCount,bool credited,uint256 epoch)',
] as const;

const EMISSIONS_GATE_EPOCH_ABI = [
  'function GENESIS() external view returns (uint256)',
  'function EPOCH_DURATION() external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
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

  async setMaxCreditsPerVerifierPerEpoch(signer: AbstractSigner, maximum: number): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'setMaxCreditsPerVerifierPerEpoch', maximum);
  }

  async submitVerificationResult(signer: AbstractSigner, input: SubmitVerificationResultInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'submitVerificationResult',
      input.auditId,
      BigInt(input.agentId),
      input.serviceHash,
      input.verdict,
      BigInt(input.expectedEpoch),
      input.modelShareBps,
      input.probeCount,
      input.evidenceHash,
    );
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

  async maxCreditsPerVerifierPerEpoch(): Promise<number> {
    return Number(await this._contract().getFunction('maxCreditsPerVerifierPerEpoch')());
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

  async epochCredits(epoch: number | bigint, verifier: string): Promise<bigint> {
    return BigInt(await this._contract().getFunction('epochCredits')(BigInt(epoch), getAddress(verifier)));
  }

  async epochTotalCredits(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('epochTotalCredits')(BigInt(epoch)));
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

  async verifierEpochTotalCredits(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('verifierEpochTotalCredits')(BigInt(epoch)));
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
    const filterFactory = contract.filters.AttestationSubmitted;
    if (!filterFactory) throw new Error('AttestationSubmitted event is missing from verification ABI');
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
}
