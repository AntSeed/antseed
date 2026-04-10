import { type AbstractSigner, Contract, ethers } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ChannelsClientConfig {
  rpcUrl: string | string[];
  contractAddress: string;
}

export interface AgentStats {
  channelCount: number;
  ghostCount: number;
  totalVolumeUsdc: bigint;
  lastSettledAt: number;
}

export interface ChannelInfo {
  buyer: string;
  seller: string;
  deposit: bigint;
  settled: bigint;
  metadataHash: string;
  deadline: bigint;
  settledAt: bigint;
  closeRequestedAt: bigint;
  status: number;
}

const CHANNELS_ABI = [
  'function reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes buyerSig) external',
  'function settle(bytes32 channelId, uint128 cumulativeAmount, bytes metadata, bytes buyerSig) external',
  'function close(bytes32 channelId, uint128 finalAmount, bytes metadata, bytes buyerSig) external',
  'function topUp(bytes32 channelId, uint128 cumulativeAmount, bytes metadata, bytes spendingSig, uint128 newMaxAmount, uint256 deadline, bytes reserveSig) external',
  'function requestClose(bytes32 channelId) external',
  'function withdraw(bytes32 channelId) external',
  'function channels(bytes32 channelId) external view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
  'function computeChannelId(address buyer, address seller, bytes32 salt) external pure returns (bytes32)',
  'function getAgentStats(uint256 agentId) external view returns (uint64 channelCount, uint64 ghostCount, uint256 totalVolumeUsdc, uint64 lastSettledAt)',
  'function domainSeparator() external view returns (bytes32)',
  'function FIRST_SIGN_CAP() external view returns (uint256)',
  'event CloseRequested(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint256 gracePeriodEnd)',
] as const;

export interface CloseRequestedEvent {
  channelId: string;
  buyer: string;
}

export class ChannelsClient extends BaseEvmClient {
  constructor(config: ChannelsClientConfig) {
    super(config.rpcUrl, config.contractAddress);
  }

  async reserve(
    signer: AbstractSigner,
    buyer: string,
    salt: string,
    maxAmount: bigint,
    deadline: bigint,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, CHANNELS_ABI, 'reserve',
      buyer, salt, maxAmount, deadline, buyerSig,
    );
  }

  async settle(
    signer: AbstractSigner,
    channelId: string,
    cumulativeAmount: bigint,
    metadata: string,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, CHANNELS_ABI, 'settle',
      channelId, cumulativeAmount, metadata, buyerSig,
    );
  }

  async close(
    signer: AbstractSigner,
    channelId: string,
    finalAmount: bigint,
    metadata: string,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, CHANNELS_ABI, 'close',
      channelId, finalAmount, metadata, buyerSig,
    );
  }

  async topUp(
    signer: AbstractSigner,
    channelId: string,
    cumulativeAmount: bigint,
    metadata: string,
    spendingSig: string,
    newMaxAmount: bigint,
    deadline: bigint,
    reserveSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, CHANNELS_ABI, 'topUp',
      channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig,
    );
  }

  async requestClose(signer: AbstractSigner, channelId: string): Promise<string> {
    return this._execWrite(signer, CHANNELS_ABI, 'requestClose', channelId);
  }

  async withdraw(signer: AbstractSigner, channelId: string): Promise<string> {
    return this._execWrite(signer, CHANNELS_ABI, 'withdraw', channelId);
  }

  async getSession(channelId: string): Promise<ChannelInfo> {
    const contract = new Contract(this._contractAddress, CHANNELS_ABI, this._provider);
    const result = await contract.getFunction('channels')(channelId);
    return {
      buyer: result[0],
      seller: result[1],
      deposit: result[2],
      settled: result[3],
      metadataHash: result[4],
      deadline: result[5],
      settledAt: result[6],
      closeRequestedAt: result[7],
      status: Number(result[8]),
    };
  }

  async domainSeparator(): Promise<string> {
    const contract = new Contract(this._contractAddress, CHANNELS_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }

  async getFirstSignCap(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, CHANNELS_ABI, this._provider);
    return contract.getFunction('FIRST_SIGN_CAP')() as Promise<bigint>;
  }

  async computeChannelId(buyer: string, seller: string, salt: string): Promise<string> {
    const contract = new Contract(this._contractAddress, CHANNELS_ABI, this._provider);
    return contract.getFunction('computeChannelId')(buyer, seller, salt) as Promise<string>;
  }

  async getAgentStats(agentId: number): Promise<AgentStats> {
    const contract = new Contract(this._contractAddress, CHANNELS_ABI, this._provider);
    const result = await contract.getFunction('getAgentStats')(agentId);
    return {
      channelCount: Number(result[0]),
      ghostCount: Number(result[1]),
      totalVolumeUsdc: result[2] as bigint,
      lastSettledAt: Number(result[3]),
    };
  }

  /**
   * Query CloseRequested events from the Channels contract.
   * Returns matching events between fromBlock and toBlock (inclusive).
   */
  async getCloseRequestedEvents(fromBlock: number | 'latest', toBlock: number | 'latest' = 'latest'): Promise<CloseRequestedEvent[]> {
    const iface = new ethers.Interface(CHANNELS_ABI);
    const eventTopic = iface.getEvent('CloseRequested')!.topicHash;

    const logs = await this._provider.getLogs({
      address: this._contractAddress,
      topics: [eventTopic],
      fromBlock,
      toBlock,
    });

    return logs.map((log) => ({
      channelId: log.topics[1]!,
      buyer: ethers.getAddress('0x' + log.topics[2]!.slice(26)),
    }));
  }

  /**
   * Get the current block number from the provider.
   */
  async getBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
  }
}
