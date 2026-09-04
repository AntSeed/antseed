import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SellerRegistryClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }
const ABI = [
  'function registerSeller(uint256 agentId) external',
  'function getAgentId(address seller) external view returns (uint256)',
  'function getStake(address seller) external view returns (uint256)',
  'function isStakedAboveMin(address seller) external view returns (bool)',
  'function minSellerPoolStake() external view returns (uint256)',
  'function legacyStakeEligibilityEnabled() external view returns (bool)',
] as const;
export class SellerRegistryClient extends BaseEvmClient {
  constructor(config: SellerRegistryClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }
  registerSeller(signer: AbstractSigner, agentId: number): Promise<string> { return this._execWrite(signer, ABI, 'registerSeller', agentId); }
  async getAgentId(seller: string): Promise<number> { return Number(await this.contract().getFunction('getAgentId')(seller)); }
  getStake(seller: string): Promise<bigint> { return this.contract().getFunction('getStake')(seller); }
  isStakedAboveMin(seller: string): Promise<boolean> { return this.contract().getFunction('isStakedAboveMin')(seller); }
  minSellerPoolStake(): Promise<bigint> { return this.contract().getFunction('minSellerPoolStake')(); }
  legacyStakeEligibilityEnabled(): Promise<boolean> { return this.contract().getFunction('legacyStakeEligibilityEnabled')(); }
}
