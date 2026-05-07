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
  'event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount)',
  'event ChannelSettled(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 cumulativeAmount, uint128 delta, uint128 totalSettled, uint256 platformFee, bytes metadata)',
  'event ChannelClosed(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 settledAmount, uint128 refund)',
  'event CloseRequested(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint256 gracePeriodEnd)',
  'event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 refund)',
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

interface ChannelEventBase {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  channelId: string;   // 0x-prefixed, 32 bytes
  buyer: string;       // lowercased
  seller: string;      // lowercased
}

export interface DecodedReserved extends ChannelEventBase {
  type: 'reserved';
  maxAmount: bigint;
}

export interface DecodedChannelSettled extends ChannelEventBase {
  type: 'settled';
  cumulativeAmount: bigint;
  delta: bigint;          // USDC charged in *this* settlement
  totalSettled: bigint;
  platformFee: bigint;
}

export interface DecodedChannelClosed extends ChannelEventBase {
  type: 'closed';
  settledAmount: bigint;
  refund: bigint;
}

export interface DecodedCloseRequested extends ChannelEventBase {
  type: 'closeRequested';
  gracePeriodEnd: bigint;
}

export interface DecodedChannelWithdrawn extends ChannelEventBase {
  type: 'withdrawn';
  refund: bigint;
}

export type DecodedChannelEvent =
  | DecodedReserved
  | DecodedChannelSettled
  | DecodedChannelClosed
  | DecodedCloseRequested
  | DecodedChannelWithdrawn;

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
   * Otherwise fall back to the configured address.
   *
   * Three outcomes:
   *   1. Probe returns a single ABI-encoded address word → cache that
   *      (facade if it differs from the configured address, non-facade
   *      otherwise).
   *   2. Probe returns `0x`, a CALL_EXCEPTION revert, or an obviously
   *      non-address payload (wrong length, non-string) → cache as
   *      non-facade. These are all "selector isn't implemented" signals.
   *   3. Probe throws a non-CALL_EXCEPTION error (network timeout, RPC
   *      5xx, rate limit) → *transient*. Return the configured address for
   *      this call only and do **not** memoize. Subsequent calls retry.
   *
   * Prior implementation memoized the fallback on any throw, which
   * permanently wedged facade mode after a single transient RPC blip —
   * signing every subsequent SpendingAuth against the wrong EIP-712 domain.
   * At worst a facade seller now mis-signs *one* auth during an RPC outage
   * (buyer verification fails, buyer retries, probe recovers, all good).
   */
  private _getReadAddress(): Promise<string> {
    if (this._readAddressPromise) return this._readAddressPromise;

    const attempt = (async (): Promise<{ value: string; cache: boolean }> => {
      const iface = new ethers.Interface(SELLER_FACADE_PROBE_ABI);
      const callData = iface.encodeFunctionData('channelsAddress');
      let raw: string;
      try {
        raw = await this._provider.call({
          to: this._contractAddress,
          data: callData,
        });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'CALL_EXCEPTION') {
          // Contract didn't implement the selector — cache non-facade.
          return { value: this._contractAddress, cache: true };
        }
        // Transient network/RPC error — don't cache.
        return { value: this._contractAddress, cache: false };
      }
      // Treat any non-66-char response (including `0x`, tuples, malformed
      // payloads) as "selector not implemented" — safe to cache as non-facade.
      if (typeof raw !== 'string' || raw.length !== 66) {
        return { value: this._contractAddress, cache: true };
      }
      const [resolved] = iface.decodeFunctionResult('channelsAddress', raw) as unknown as [string];
      const value = resolved.toLowerCase() === this._contractAddress.toLowerCase()
        ? this._contractAddress
        : resolved;
      return { value, cache: true };
    })();

    // Memoize the promise that resolves to the *value* only when the probe
    // reports a cacheable outcome. Otherwise clear the memo post-resolution
    // so the next caller re-probes.
    const valuePromise = attempt.then(({ value, cache }) => {
      if (!cache && this._readAddressPromise === valuePromise) {
        this._readAddressPromise = null;
      }
      return value;
    });
    // If `attempt` itself rejects (shouldn't, since we catch above, but
    // defence in depth), clear the memo.
    valuePromise.catch(() => {
      if (this._readAddressPromise === valuePromise) {
        this._readAddressPromise = null;
      }
    });
    this._readAddressPromise = valuePromise;
    return valuePromise;
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
   * Read all indexed lifecycle events (Reserved, ChannelSettled, ChannelClosed,
   * CloseRequested, ChannelWithdrawn) in [fromBlock, toBlock], sorted ascending
   * by (blockNumber, logIndex). Reads from `_contractAddress` directly — no
   * facade probe, since callers (network-stats indexers) point at canonical
   * AntseedChannels deployments.
   */
  async getChannelEvents(params: {
    fromBlock: number;
    toBlock: number;
  }): Promise<DecodedChannelEvent[]> {
    const iface = new ethers.Interface(CHANNELS_ABI);
    const eventTopics = [
      iface.getEvent('Reserved')!.topicHash,
      iface.getEvent('ChannelSettled')!.topicHash,
      iface.getEvent('ChannelClosed')!.topicHash,
      iface.getEvent('CloseRequested')!.topicHash,
      iface.getEvent('ChannelWithdrawn')!.topicHash,
    ];

    const logs = await this._provider.getLogs({
      address: this._contractAddress,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [eventTopics],
    });

    const events: DecodedChannelEvent[] = [];
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      const args = parsed.args;
      const base: ChannelEventBase = {
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        channelId: args.channelId,
        buyer: (args.buyer as string).toLowerCase(),
        seller: (args.seller as string).toLowerCase(),
      };
      switch (parsed.name) {
        case 'Reserved':
          events.push({ ...base, type: 'reserved', maxAmount: args.maxAmount });
          break;
        case 'ChannelSettled':
          events.push({
            ...base,
            type: 'settled',
            cumulativeAmount: args.cumulativeAmount,
            delta: args.delta,
            totalSettled: args.totalSettled,
            platformFee: args.platformFee,
          });
          break;
        case 'ChannelClosed':
          events.push({
            ...base,
            type: 'closed',
            settledAmount: args.settledAmount,
            refund: args.refund,
          });
          break;
        case 'CloseRequested':
          events.push({ ...base, type: 'closeRequested', gracePeriodEnd: args.gracePeriodEnd });
          break;
        case 'ChannelWithdrawn':
          events.push({ ...base, type: 'withdrawn', refund: args.refund });
          break;
      }
    }
    events.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );
    return events;
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
