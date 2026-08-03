import { Contract, getAddress, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface RelayTreasuryClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface RelayTreasuryReservation {
  epoch: bigint;
  payoutPerJobUsdc: bigint;
  totalBudgetUsdc: bigint;
  remainingBudgetUsdc: bigint;
  jobCount: number;
  paidJobCount: number;
  releaseAfter: number;
  released: boolean;
}

export const RELAY_TREASURY_ABI = [
  'function usdc() external view returns (address)',
  'function verifierRegistry() external view returns (address)',
  'function totalLockedUsdc() external view returns (uint256)',
  'function maxPayoutPerJob() external view returns (uint96)',
  'function maxPayoutPerAudit() external view returns (uint96)',
  'function maxCommittedBudgetPerEpoch() external view returns (uint96)',
  'function committedBudgetByEpoch(uint256 epoch) external view returns (uint256)',
  'function lockedBudgetByEpoch(uint256 epoch) external view returns (uint256)',
  'function availableBalance() external view returns (uint256)',
  'function getReservation(bytes32 auditId) external view returns ((uint256 epoch,uint96 payoutPerJobUsdc,uint96 totalBudgetUsdc,uint96 remainingBudgetUsdc,uint16 jobCount,uint16 paidJobCount,uint64 releaseAfter,bool released))',
  'function fund(uint256 amount) external',
  'function releaseExpiredAuditBudget(bytes32 auditId) external',
] as const;

export class RelayTreasuryClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;

  constructor(config: RelayTreasuryClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, RELAY_TREASURY_ABI, this._provider);
    return this._contractInstance;
  }

  async usdc(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('usdc')()));
  }

  async verifierRegistry(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('verifierRegistry')()));
  }

  async totalLockedUsdc(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('totalLockedUsdc')());
  }

  async maxPayoutPerJob(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('maxPayoutPerJob')());
  }

  async maxPayoutPerAudit(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('maxPayoutPerAudit')());
  }

  async maxCommittedBudgetPerEpoch(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('maxCommittedBudgetPerEpoch')());
  }

  async committedBudgetByEpoch(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('committedBudgetByEpoch')(BigInt(epoch)));
  }

  async lockedBudgetByEpoch(epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('lockedBudgetByEpoch')(BigInt(epoch)));
  }

  async availableBalance(): Promise<bigint> {
    return BigInt(await this._contract().getFunction('availableBalance')());
  }

  async getReservation(auditId: string): Promise<RelayTreasuryReservation> {
    const raw = await this._contract().getFunction('getReservation')(auditId) as Record<string | number, unknown> & unknown[];
    return {
      epoch: BigInt(raw.epoch as bigint ?? raw[0] as bigint),
      payoutPerJobUsdc: BigInt(raw.payoutPerJobUsdc as bigint ?? raw[1] as bigint),
      totalBudgetUsdc: BigInt(raw.totalBudgetUsdc as bigint ?? raw[2] as bigint),
      remainingBudgetUsdc: BigInt(raw.remainingBudgetUsdc as bigint ?? raw[3] as bigint),
      jobCount: Number(raw.jobCount ?? raw[4]),
      paidJobCount: Number(raw.paidJobCount ?? raw[5]),
      releaseAfter: Number(raw.releaseAfter ?? raw[6]),
      released: Boolean(raw.released ?? raw[7]),
    };
  }

  async fund(signer: AbstractSigner, amountUsdc: bigint): Promise<string> {
    return this._approveAndExec(signer, await this.usdc(), amountUsdc, RELAY_TREASURY_ABI, 'fund', amountUsdc);
  }

  async releaseExpiredAuditBudget(signer: AbstractSigner, auditId: string): Promise<string> {
    return this._execWrite(signer, RELAY_TREASURY_ABI, 'releaseExpiredAuditBudget', auditId);
  }
}
