import { TypedDataEncoder, verifyTypedData } from 'ethers';
import { makeChannelsDomain, RESERVE_AUTH_TYPES } from '@antseed/protocol/signatures';
import { ChannelsClient, type ChannelInfo } from './evm/channels-client.js';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from './channel-store.js';
import { debugWarn } from '../utils/debug.js';

type ReconcilerConfig = {
  store: ChannelStore;
  client: ChannelsClient;
  buyerAddress: string;
  chainId: number;
  rpcUrl: string;
  maxReserveAmountUsdc: bigint;
  onCurrentChannelRetired?: (peerId: string) => void;
};

export class BuyerChannelReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly config: ReconcilerConfig) {}

  start(): void {
    if (this.timer || this.stopped) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().catch((error: unknown) => {
      debugWarn(`[BuyerChannels] Reconciliation deferred: ${error instanceof Error ? error.message : error}`);
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const { store, client, buyerAddress } = this.config;
    const channels = store.getActiveChannelsByBuyer(CHANNEL_ROLE.BUYER, buyerAddress);
    if (channels.length === 0) return;
    const expectedDomain = TypedDataEncoder.hashDomain(makeChannelsDomain(this.config.chainId, client.contractAddress));
    if ((await client.domainSeparator()).toLowerCase() !== expectedDomain.toLowerCase() || this.stopped) return;
    const block = await client.provider.getBlock('finalized');
    if (!block || this.stopped) return;
    for (let offset = 0; offset < channels.length && !this.stopped; offset += 4) {
      await Promise.allSettled(channels.slice(offset, offset + 4).map(async (channel) => {
        let info = await client.getSession(channel.sessionId, block.number);
        if (this.stopped) return;
        if (info.status === 0) {
          if (this.isExpiredOpeningForThisDeployment(channel, block.timestamp)) {
            this.retire(channel, CHANNEL_STATUS.GHOST);
            return;
          }
          const sellerClient = new ChannelsClient({
            rpcUrl: this.config.rpcUrl,
            contractAddress: channel.sellerEvmAddr,
            evmChainId: this.config.chainId,
          }).withProvider(client.provider);
          info = await sellerClient.getSession(channel.sessionId, block.number);
        }
        if (this.stopped || !this.matchesParticipants(channel, info)) return;
        if (info.status === 2) this.retire(channel, CHANNEL_STATUS.SETTLED, info.settled.toString());
        if (info.status === 3) this.retire(channel, CHANNEL_STATUS.TIMEOUT, info.settled.toString());
      }));
    }
  }

  private matchesParticipants(channel: StoredChannel, info: ChannelInfo): boolean {
    return info.buyer.toLowerCase() === channel.buyerEvmAddr.toLowerCase()
      && info.seller.toLowerCase() === channel.sellerEvmAddr.toLowerCase();
  }

  private isExpiredOpeningForThisDeployment(channel: StoredChannel, chainTimestamp: number): boolean {
    const deadline = channel.latestReserveDeadline ?? channel.deadline;
    if (deadline >= chainTimestamp || deadline <= 0 || channel.requestCount !== 0
      || BigInt(channel.authMax) !== 0n || BigInt(channel.tokensDelivered) !== 0n
      || BigInt(channel.previousConsumption) !== 0n || channel.latestSpendingAuthSig) return false;
    const signature = channel.latestReserveAuthSig ?? channel.latestBuyerSig;
    if (!signature) return false;
    try {
      const signer = verifyTypedData(
        makeChannelsDomain(this.config.chainId, this.config.client.contractAddress),
        RESERVE_AUTH_TYPES,
        {
          channelId: channel.sessionId,
          maxAmount: BigInt(channel.reserveMaxAmount ?? channel.initialReserveAmount ?? this.config.maxReserveAmountUsdc),
          deadline: BigInt(deadline),
        },
        signature,
      );
      return signer.toLowerCase() === channel.buyerEvmAddr.toLowerCase();
    } catch {
      return false;
    }
  }

  private retire(channel: StoredChannel, status: typeof CHANNEL_STATUS.SETTLED | typeof CHANNEL_STATUS.TIMEOUT | typeof CHANNEL_STATUS.GHOST, settled?: string): void {
    if (this.stopped) return;
    const { store } = this.config;
    const current = store.getChannel(channel.sessionId);
    if (!current || current.status !== CHANNEL_STATUS.ACTIVE
      || current.updatedAt !== channel.updatedAt || current.authMax !== channel.authMax
      || current.requestCount !== channel.requestCount || current.tokensDelivered !== channel.tokensDelivered
      || current.previousConsumption !== channel.previousConsumption || current.latestBuyerSig !== channel.latestBuyerSig
      || current.deadline !== channel.deadline || current.latestReserveDeadline !== channel.latestReserveDeadline
      || current.latestReserveAuthSig !== channel.latestReserveAuthSig || current.reserveMaxAmount !== channel.reserveMaxAmount) return;
    const active = store.getActiveChannelByPeerAndBuyer(channel.peerId, CHANNEL_ROLE.BUYER, channel.buyerEvmAddr);
    store.updateChannelStatus(channel.sessionId, status, settled);
    if (active?.sessionId === channel.sessionId) this.config.onCurrentChannelRetired?.(channel.peerId);
  }
}
