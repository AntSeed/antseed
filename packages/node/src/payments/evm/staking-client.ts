import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface StakingClientConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
}

export interface SellerAccountInfo {
  stake: bigint;
  stakedAt: bigint;
  tokenRate: bigint;
}

const STAKING_ABI = [
  'function stake(uint256 amount) external',
  'function unstake() external',
  'function setTokenRate(uint256 rate) external',
  'function getSellerAccount(address seller) external view returns (uint256 stake, uint256 stakedAt, uint256 tokenRate)',
  'function getStake(address seller) external view returns (uint256)',
  'function getTokenRate(address seller) external view returns (uint256)',
  'function isStakedAboveMin(address seller) external view returns (bool)',
  'function activeSessionCount(address seller) external view returns (uint256)',
] as const;

export class StakingClient extends BaseEvmClient {
  private readonly _usdcAddress: string;

  constructor(config: StakingClientConfig) {
    super(config.rpcUrl, config.contractAddress);
    this._usdcAddress = config.usdcAddress;
  }

  async stake(signer: AbstractSigner, amount: bigint): Promise<string> {
    return this._approveAndExec(signer, this._usdcAddress, amount, STAKING_ABI, 'stake', amount);
  }

  async unstake(signer: AbstractSigner): Promise<string> {
    return this._execWrite(signer, STAKING_ABI, 'unstake');
  }

  async setTokenRate(signer: AbstractSigner, rate: bigint): Promise<string> {
    return this._execWrite(signer, STAKING_ABI, 'setTokenRate', rate);
  }

  async getSellerAccount(sellerAddr: string): Promise<SellerAccountInfo> {
    const contract = new Contract(this._contractAddress, STAKING_ABI, this._provider);
    const result = await contract.getFunction('getSellerAccount')(sellerAddr);
    return {
      stake: result[0] as bigint,
      stakedAt: result[1] as bigint,
      tokenRate: result[2] as bigint,
    };
  }

  async getStake(sellerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, STAKING_ABI, this._provider);
    return contract.getFunction('getStake')(sellerAddr) as Promise<bigint>;
  }

  async getTokenRate(sellerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, STAKING_ABI, this._provider);
    return contract.getFunction('getTokenRate')(sellerAddr) as Promise<bigint>;
  }

  async isStakedAboveMin(sellerAddr: string): Promise<boolean> {
    const contract = new Contract(this._contractAddress, STAKING_ABI, this._provider);
    return contract.getFunction('isStakedAboveMin')(sellerAddr) as Promise<boolean>;
  }
}
