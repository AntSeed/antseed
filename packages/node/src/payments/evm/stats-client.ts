import { Contract } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface StatsClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

export interface AgentStats {
  sessionCount: number;
  ghostCount: number;
  totalVolumeUsdc: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  totalLatencyMs: bigint;
  totalRequestCount: number;
  lastSettledAt: number;
}

const STATS_ABI = [
  'function getStats(uint256 agentId) external view returns (uint64,uint64,uint256,uint128,uint128,uint64,uint64,uint64)',
] as const;

export class StatsClient extends BaseEvmClient {
  constructor(config: StatsClientConfig) {
    super(config.rpcUrl, config.contractAddress);
  }

  async getStats(agentId: number): Promise<AgentStats> {
    const contract = new Contract(this._contractAddress, STATS_ABI, this._provider);
    const result = await contract.getFunction('getStats')(agentId);
    return {
      sessionCount: Number(result[0]),
      ghostCount: Number(result[1]),
      totalVolumeUsdc: result[2] as bigint,
      totalInputTokens: result[3] as bigint,
      totalOutputTokens: result[4] as bigint,
      totalLatencyMs: result[5] as bigint,
      totalRequestCount: Number(result[6]),
      lastSettledAt: Number(result[7]),
    };
  }
}
