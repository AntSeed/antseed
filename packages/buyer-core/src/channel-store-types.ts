/**
 * Channel bookkeeping types shared between the sqlite ChannelStore in
 * @antseed/node and browser implementations. Moved from
 * packages/node/src/payments/channel-store.ts.
 */

import type { SpendingAuthMetadata, SpendingAuthServiceMetadata } from '@antseed/protocol/signatures';

export const CHANNEL_STATUS = {
  ACTIVE: 'active',
  SETTLED: 'settled',
  TIMEOUT: 'timeout',
  GHOST: 'ghost',
} as const;

export const CHANNEL_KIND = {
  PAID: 'paid',
  FREE: 'free',
} as const;

export const CHANNEL_ROLE = {
  BUYER: 'buyer',
  SELLER: 'seller',
} as const;

export type ChannelStatus = typeof CHANNEL_STATUS[keyof typeof CHANNEL_STATUS];
export type ChannelKind = typeof CHANNEL_KIND[keyof typeof CHANNEL_KIND];
export type ChannelRole = typeof CHANNEL_ROLE[keyof typeof CHANNEL_ROLE];

export interface StoredChannel {
  sessionId: string;
  peerId: string;
  role: ChannelRole;
  channelKind?: ChannelKind;
  sellerEvmAddr: string;
  buyerEvmAddr: string;
  nonce: number;
  authMax: string;          // bigint stored as string
  deadline: number;
  previousSessionId: string;
  previousConsumption: string; // bigint as string
  tokensDelivered: string;    // bigint as string
  requestCount: number;
  reservedAt: number;
  settledAt: number | null;
  settledAmount: string | null; // bigint as string
  status: ChannelStatus;
  latestBuyerSig: string | null;
  latestSpendingAuthSig: string | null;
  latestMetadata: string | null;       // hex-encoded
  createdAt: number;
  updatedAt: number;
}

export interface StoredChannelServiceTotal {
  sessionId: string;
  serviceId: string;
  cumulativeAmount: string; // bigint as string
  cumulativeInputTokens: string; // bigint as string
  cumulativeCachedInputTokens: string; // bigint as string
  cumulativeOutputTokens: string; // bigint as string
  cumulativeRequestCount: string; // bigint as string
  /** bigint as string; optional — rows/callers predating migration 005 default to '0'. */
  cumulativeOutputImages?: string;
  updatedAt: number;
}

/**
 * The store surface the buyer machinery uses. @antseed/node's sqlite
 * ChannelStore implements it; other environments can supply their own
 * backing store.
 */
export interface BuyerChannelStore {
  upsertChannel(channel: StoredChannel): void;
  getChannel(sessionId: string): StoredChannel | null;
  getActiveChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind?: ChannelKind,
  ): StoredChannel | null;
  getLatestChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind?: ChannelKind,
  ): StoredChannel | null;
  getActiveChannelsByBuyer(
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind?: ChannelKind,
  ): StoredChannel[];
  updateChannelStatus(sessionId: string, status: ChannelStatus, settledAmount?: string): void;
  replaceMetadataServiceTotals(
    sessionId: string,
    services?: readonly SpendingAuthServiceMetadata[],
  ): void;
  getChannelMetadata(channel: StoredChannel): SpendingAuthMetadata;
}
