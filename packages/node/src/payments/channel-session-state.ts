import type { ChannelInfo } from './evm/channels-client.js';

export type OnChainChannelStatus = 'missing' | 'active' | 'settled' | 'timeout' | 'unknown';

export type OnChainChannelState =
  | { exists: false; status: 'missing' }
  | { exists: true; status: Exclude<OnChainChannelStatus, 'missing'>; channel: ChannelInfo };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function classifyOnChainChannel(channel: ChannelInfo): OnChainChannelState {
  const exists = channel.buyer !== ZERO_ADDRESS
    || channel.seller !== ZERO_ADDRESS
    || channel.deposit > 0n
    || channel.status !== 0;

  if (!exists) {
    return { exists: false, status: 'missing' };
  }

  if (channel.status === 1) {
    return { exists: true, status: 'active', channel };
  }
  if (channel.status === 2) {
    return { exists: true, status: 'settled', channel };
  }
  if (channel.status === 3) {
    return { exists: true, status: 'timeout', channel };
  }

  return { exists: true, status: 'unknown', channel };
}

export function matchesChannelParties(
  channel: ChannelInfo,
  buyerEvmAddr: string,
  sellerEvmAddr: string,
): boolean {
  return channel.buyer.toLowerCase() === buyerEvmAddr.toLowerCase()
    && channel.seller.toLowerCase() === sellerEvmAddr.toLowerCase();
}
