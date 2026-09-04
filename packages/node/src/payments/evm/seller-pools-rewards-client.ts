import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SellerPoolsRewardsClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }
const ABI = [
  'function pendingIndexedStakerReward(uint256 positionId) external view returns (uint256)',
  'function claimStakerRewards(uint256 positionId, address recipient) external',
  'function claimStakerRewardsBatch(uint256[] positionIds, address recipient) external',
] as const;
export class SellerPoolsRewardsClient extends BaseEvmClient {
  constructor(config: SellerPoolsRewardsClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  pendingIndexedStakerReward(positionId: number): Promise<bigint> { return new Contract(this._contractAddress, ABI, this._provider).getFunction('pendingIndexedStakerReward')(positionId); }
  claimStakerRewards(signer: AbstractSigner, positionId: number, recipient: string): Promise<string> { return this._execWrite(signer, ABI, 'claimStakerRewards', positionId, recipient); }
  claimStakerRewardsBatch(signer: AbstractSigner, positionIds: number[], recipient: string): Promise<string> { return this._execWrite(signer, ABI, 'claimStakerRewardsBatch', positionIds, recipient); }
}
