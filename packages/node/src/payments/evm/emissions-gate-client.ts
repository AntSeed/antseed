import { Contract } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
export interface EmissionsGateClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }
const ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function effectiveEpoch() external view returns (uint256)',
  'function currentEmissionRate() external view returns (uint256)',
  'function epochDuration() external view returns (uint256)',
  'function getEpochEmission(uint256 epoch) external view returns (uint256)',
] as const;
export class EmissionsGateClient extends BaseEvmClient {
  constructor(config: EmissionsGateClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }
  async currentEpoch(): Promise<number> { return Number(await this.contract().getFunction('currentEpoch')()); }
  async effectiveEpoch(): Promise<number> { return Number(await this.contract().getFunction('effectiveEpoch')()); }
  currentEmissionRate(): Promise<bigint> { return this.contract().getFunction('currentEmissionRate')(); }
  async epochDuration(): Promise<number> { return Number(await this.contract().getFunction('epochDuration')()); }
  getEpochEmission(epoch: number): Promise<bigint> { return this.contract().getFunction('getEpochEmission')(epoch); }
}
