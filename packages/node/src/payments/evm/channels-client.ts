import { type AbstractSigner, Contract, ethers } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ChannelsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
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

/// @dev Probe ABI for the seller-facade passthrough. Present on
///      AntseedSellerDelegation (and derivatives like DiemStakingProxy); absent
///      on plain AntseedChannels. Used at init to discover the underlying
///      channels contract when the configured address is a seller facade.
const SELLER_FACADE_PROBE_ABI = [
  'function channelsAddress() external view returns (address)',
] as const;

export interface CloseRequestedEvent {
  channelId: string;
  buyer: string;
}

export class ChannelsClient extends BaseEvmClient {
  /**
   * The underlying AntseedChannels address used for reads + event filters.
   * When the configured `contractAddress` is a seller facade (e.g.
   * DiemStakingProxy), this resolves to the real channels contract via the
   * facade's `channelsAddress()` view. Otherwise it equals `_contractAddress`.
   * Probed lazily on first read.
   */
  private _readAddressPromise: Promise<string> | null = null;

  constructor(config: ChannelsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  /**
   * Resolve the read address (underlying AntseedChannels). If the configured
   * contract exposes `channelsAddress()` (i.e. is a seller facade), use that.
   * Otherwise fall back to the configured address. Cached after first call.
   */
  private _getReadAddress(): Promise<string> {
    if (!this._readAddressPromise) {
      this._readAddressPromise = (async () => {
        try {
          const iface = new ethers.Interface(SELLER_FACADE_PROBE_ABI);
          const callData = iface.encodeFunctionData('channelsAddress');
          const raw = await this._provider.call({
            to: this._contractAddress,
            data: callData,
          });
          // Only treat the contract as a seller facade when the probe returns
          // exactly one ABI word (a single address). Some mocks/stubs return
          // generic tuple payloads for every eth_call, which ethers would
          // otherwise partially decode as a bogus address.
          if (typeof raw !== 'string' || raw.length !== 66) {
            throw new Error('invalid channelsAddress() probe response');
          }
          const [resolved] = iface.decodeFunctionResult('channelsAddress', raw) as unknown as [string];
          return resolved.toLowerCase() === this._contractAddress.toLowerCase()
            ? this._contractAddress
            : resolved;
        } catch {
          // Not a facade — configured address is the real channels contract.
          return this._contractAddress;
        }
      })();
    }
    return this._readAddressPromise;
  }

  /** The resolved underlying channels address. Triggers the probe if not yet resolved. */
  get readAddress(): Promise<string> {
    return this._getReadAddress();
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
    const contract = new Contract(await this._getReadAddress(), CHANNELS_ABI, this._provider);
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
    const contract = new Contract(await this._getReadAddress(), CHANNELS_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }

  async getFirstSignCap(): Promise<bigint> {
    const contract = new Contract(await this._getReadAddress(), CHANNELS_ABI, this._provider);
    return contract.getFunction('FIRST_SIGN_CAP')() as Promise<bigint>;
  }

  async computeChannelId(buyer: string, seller: string, salt: string): Promise<string> {
    const contract = new Contract(await this._getReadAddress(), CHANNELS_ABI, this._provider);
    return contract.getFunction('computeChannelId')(buyer, seller, salt) as Promise<string>;
  }

  async getAgentStats(agentId: number): Promise<AgentStats> {
    const contract = new Contract(await this._getReadAddress(), CHANNELS_ABI, this._provider);
    const result = await contract.getFunction('getAgentStats')(agentId);
    return {
      channelCount: Number(result[0]),
      ghostCount: Number(result[1]),
      totalVolumeUsdc: result[2] as bigint,
      lastSettledAt: Number(result[3]),
    };
  }

  /**
   * Query CloseRequested events from the underlying AntseedChannels contract.
   * Returns matching events between fromBlock and toBlock (inclusive).
   */
  async getCloseRequestedEvents(fromBlock: number | 'latest', toBlock: number | 'latest' = 'latest'): Promise<CloseRequestedEvent[]> {
    const iface = new ethers.Interface(CHANNELS_ABI);
    const eventTopic = iface.getEvent('CloseRequested')!.topicHash;

    const logs = await this._provider.getLogs({
      address: await this._getReadAddress(),
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
