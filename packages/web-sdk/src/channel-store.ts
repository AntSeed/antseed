/**
 * In-memory BuyerChannelStore for browser buyers. Mirrors the query semantics
 * of @antseed/node's sqlite ChannelStore for the buyer-side subset. State is
 * lost on page reload; the payment stack then opens a fresh channel on the
 * seller's next 402.
 */

import type {
  BuyerChannelStore,
  ChannelKind,
  ChannelRole,
  ChannelStatus,
  StoredChannel,
} from '@antseed/buyer-core/channel-store-types';
import { CHANNEL_KIND, CHANNEL_STATUS } from '@antseed/buyer-core/channel-store-types';
import type { SpendingAuthMetadata, SpendingAuthServiceMetadata } from '@antseed/protocol/signatures';

export class MemoryChannelStore implements BuyerChannelStore {
  private channels = new Map<string, StoredChannel>();
  private serviceTotals = new Map<string, SpendingAuthServiceMetadata[]>();

  upsertChannel(channel: StoredChannel): void {
    this.channels.set(channel.sessionId, { ...channel, updatedAt: Date.now() });
  }

  getChannel(sessionId: string): StoredChannel | null {
    return this.channels.get(sessionId) ?? null;
  }

  getActiveChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind: ChannelKind = CHANNEL_KIND.PAID,
  ): StoredChannel | null {
    return this.latestMatching(
      (c) =>
        c.peerId === peerId &&
        c.role === role &&
        c.buyerEvmAddr === buyerEvmAddr &&
        (c.channelKind ?? CHANNEL_KIND.PAID) === channelKind &&
        c.status === CHANNEL_STATUS.ACTIVE,
    );
  }

  getLatestChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind: ChannelKind = CHANNEL_KIND.PAID,
  ): StoredChannel | null {
    return this.latestMatching(
      (c) =>
        c.peerId === peerId &&
        c.role === role &&
        c.buyerEvmAddr === buyerEvmAddr &&
        (c.channelKind ?? CHANNEL_KIND.PAID) === channelKind,
    );
  }

  getActiveChannelsByBuyer(
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind: ChannelKind = CHANNEL_KIND.PAID,
  ): StoredChannel[] {
    return [...this.channels.values()].filter(
      (c) =>
        c.role === role &&
        c.buyerEvmAddr === buyerEvmAddr &&
        (c.channelKind ?? CHANNEL_KIND.PAID) === channelKind &&
        c.status === CHANNEL_STATUS.ACTIVE,
    );
  }

  updateChannelStatus(sessionId: string, status: ChannelStatus, settledAmount?: string): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    this.channels.set(sessionId, {
      ...channel,
      status,
      settledAmount: settledAmount ?? channel.settledAmount,
      settledAt: status === CHANNEL_STATUS.SETTLED ? Date.now() : channel.settledAt,
      updatedAt: Date.now(),
    });
  }

  replaceMetadataServiceTotals(
    sessionId: string,
    services: readonly SpendingAuthServiceMetadata[] = [],
  ): void {
    this.serviceTotals.set(sessionId, services.map((s) => ({ ...s })));
  }

  getChannelMetadata(channel: StoredChannel): SpendingAuthMetadata {
    return {
      cumulativeInputTokens: BigInt(channel.tokensDelivered),
      cumulativeOutputTokens: BigInt(channel.previousConsumption),
      cumulativeRequestCount: BigInt(channel.requestCount),
      services: (this.serviceTotals.get(channel.sessionId) ?? []).map((s) => ({ ...s })),
    };
  }

  private latestMatching(predicate: (channel: StoredChannel) => boolean): StoredChannel | null {
    let latest: StoredChannel | null = null;
    for (const channel of this.channels.values()) {
      if (!predicate(channel)) continue;
      if (!latest || channel.createdAt > latest.createdAt) latest = channel;
    }
    return latest;
  }
}
