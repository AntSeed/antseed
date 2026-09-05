import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface UsageRewardsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

const USAGE_REWARDS_ABI = [
  'function pendingAgentReward(uint256 agentId, uint256 epoch) external view returns (uint256)',
  'function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256)',
  'function agentEpochClaimed(uint256 agentId, uint256 epoch) external view returns (bool)',
  'function buyerEpochClaimed(address buyer, uint256 epoch) external view returns (bool)',
  'function claimAgentReward(uint256 agentId, uint256 epoch) external',
  'function claimBuyerReward(address buyer, uint256 epoch) external',
  'function rewardRecipient(uint256 agentId) external view returns (address)',
] as const;

export class UsageRewardsClient extends BaseEvmClient {
  constructor(config: UsageRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private contract(): Contract { return new Contract(this._contractAddress, USAGE_REWARDS_ABI, this._provider); }
  pendingAgentReward(agentId: number, epoch: number): Promise<bigint> { return this.contract().getFunction('pendingAgentReward')(agentId, epoch); }
  pendingBuyerReward(buyer: string, epoch: number): Promise<bigint> { return this.contract().getFunction('pendingBuyerReward')(buyer, epoch); }
  agentEpochClaimed(agentId: number, epoch: number): Promise<boolean> { return this.contract().getFunction('agentEpochClaimed')(agentId, epoch); }
  buyerEpochClaimed(buyer: string, epoch: number): Promise<boolean> { return this.contract().getFunction('buyerEpochClaimed')(buyer, epoch); }
  claimAgentReward(signer: AbstractSigner, agentId: number, epoch: number): Promise<string> { return this._execWrite(signer, USAGE_REWARDS_ABI, 'claimAgentReward', agentId, epoch); }
  claimBuyerReward(signer: AbstractSigner, buyer: string, epoch: number): Promise<string> { return this._execWrite(signer, USAGE_REWARDS_ABI, 'claimBuyerReward', buyer, epoch); }
  rewardRecipient(agentId: number): Promise<string> { return this.contract().getFunction('rewardRecipient')(agentId); }
}
