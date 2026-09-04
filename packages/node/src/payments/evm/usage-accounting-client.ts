import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface UsageAccountingClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

const USAGE_ACCOUNTING_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function firstRewardedEpoch() external view returns (uint256)',
  'function pendingEmissions(address account, uint256[] epochs) external view returns (uint256 seller, uint256 buyer)',
  'function claimSellerEmissions(uint256[] epochs) external',
  'function sellerPointsByEpoch(uint256 epoch, address seller) external view returns (uint256)',
  'function buyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256)',
  'function sellerAgentIdByEpoch(uint256 epoch, address seller) external view returns (uint256)',
] as const;

export class UsageAccountingClient extends BaseEvmClient {
  constructor(config: UsageAccountingClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private contract(): Contract { return new Contract(this._contractAddress, USAGE_ACCOUNTING_ABI, this._provider); }
  async currentEpoch(): Promise<number> { return Number(await this.contract().getFunction('currentEpoch')()); }
  async firstRewardedEpoch(): Promise<number> { return Number(await this.contract().getFunction('firstRewardedEpoch')()); }
  async pendingEmissions(account: string, epochs: number[]): Promise<{ seller: bigint; buyer: bigint }> {
    const [seller, buyer] = await this.contract().getFunction('pendingEmissions')(account, epochs);
    return { seller, buyer };
  }
  claimSellerEmissions(signer: AbstractSigner, epochs: number[]): Promise<string> {
    return this._execWrite(signer, USAGE_ACCOUNTING_ABI, 'claimSellerEmissions', epochs);
  }
  sellerPointsByEpoch(epoch: number, seller: string): Promise<bigint> {
    return this.contract().getFunction('sellerPointsByEpoch')(epoch, seller);
  }
  buyerPointsByEpoch(epoch: number, buyer: string): Promise<bigint> {
    return this.contract().getFunction('buyerPointsByEpoch')(epoch, buyer);
  }
  async sellerAgentIdByEpoch(epoch: number, seller: string): Promise<number> {
    return Number(await this.contract().getFunction('sellerAgentIdByEpoch')(epoch, seller));
  }
}
