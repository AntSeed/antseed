import { type AbstractSigner, Contract } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { computeFreeUsageChannelId } from './signatures.js';

export interface FreeUsageClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface FreeUsageAgentStats {
  channelCount: number;
  lastSettledAt: number;
}

export interface FreeUsageChannelInfo {
  buyer: string;
  seller: string;
  latestSequence: bigint;
  metadataHash: string;
  deadline: bigint;
  updatedAt: bigint;
  closedAt: bigint;
  status: number;
}

const FREE_USAGE_ABI = [
  'function open(address buyer, bytes32 salt, uint256 deadline, bytes buyerSig) external',
  'function record(bytes32 channelId, uint256 sequence, bytes metadata, uint256 deadline, bytes buyerSig) external',
  'function close(bytes32 channelId, uint256 sequence, bytes metadata, uint256 deadline, bytes buyerSig) external',
  'function channels(bytes32 channelId) external view returns (address buyer, address seller, uint256 latestSequence, bytes32 metadataHash, uint256 deadline, uint256 updatedAt, uint256 closedAt, uint8 status)',
  'function computeChannelId(address buyer, address seller, bytes32 salt) external pure returns (bytes32)',
  'function getAgentStats(uint256 agentId) external view returns (uint64 channelCount, uint64 lastSettledAt)',
  'function activeChannelCount(address seller) external view returns (uint256)',
  'function domainSeparator() external view returns (bytes32)',
] as const;

export class FreeUsageClient extends BaseEvmClient {
  constructor(config: FreeUsageClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  async open(
    signer: AbstractSigner,
    buyer: string,
    salt: string,
    deadline: bigint,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(signer, FREE_USAGE_ABI, 'open', buyer, salt, deadline, buyerSig);
  }

  async record(
    signer: AbstractSigner,
    channelId: string,
    sequence: bigint,
    metadata: string,
    deadline: bigint,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(signer, FREE_USAGE_ABI, 'record', channelId, sequence, metadata, deadline, buyerSig);
  }

  async close(
    signer: AbstractSigner,
    channelId: string,
    sequence: bigint,
    metadata: string,
    deadline: bigint,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(signer, FREE_USAGE_ABI, 'close', channelId, sequence, metadata, deadline, buyerSig);
  }

  async getSession(channelId: string): Promise<FreeUsageChannelInfo> {
    const contract = new Contract(this._contractAddress, FREE_USAGE_ABI, this._provider);
    const result = await contract.getFunction('channels')(channelId);
    return {
      buyer: result[0],
      seller: result[1],
      latestSequence: result[2],
      metadataHash: result[3],
      deadline: result[4],
      updatedAt: result[5],
      closedAt: result[6],
      status: Number(result[7]),
    };
  }

  computeChannelId(buyer: string, seller: string, salt: string): string {
    return computeFreeUsageChannelId(buyer, seller, salt);
  }

  async getAgentStats(agentId: number): Promise<FreeUsageAgentStats> {
    const contract = new Contract(this._contractAddress, FREE_USAGE_ABI, this._provider);
    const result = await contract.getFunction('getAgentStats')(agentId);
    return {
      channelCount: Number(result[0]),
      lastSettledAt: Number(result[1]),
    };
  }

  async activeChannelCount(seller: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, FREE_USAGE_ABI, this._provider);
    return contract.getFunction('activeChannelCount')(seller) as Promise<bigint>;
  }

  async domainSeparator(): Promise<string> {
    const contract = new Contract(this._contractAddress, FREE_USAGE_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }
}
