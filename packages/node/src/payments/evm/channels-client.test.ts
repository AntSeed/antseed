import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { ChannelsClient } from './channels-client.js';

const CHANNELS_ABI = [
  'event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount)',
  'event ChannelSettled(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 cumulativeAmount, uint128 delta, uint128 totalSettled, uint256 platformFee, bytes metadata)',
  'event ChannelClosed(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 settledAmount, uint128 refund)',
  'event CloseRequested(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint256 gracePeriodEnd)',
  'event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 refund)',
] as const;

const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000001';
const CHANNEL_ID = '0x' + 'aa'.repeat(32);
const BUYER = ethers.getAddress('0x' + 'b'.repeat(40));
const SELLER = ethers.getAddress('0x' + 'c'.repeat(40));

function makeClient(): ChannelsClient {
  return new ChannelsClient({ rpcUrl: 'http://localhost:8545', contractAddress: CONTRACT_ADDRESS });
}

interface BuildLogParams {
  event: 'Reserved' | 'ChannelSettled' | 'ChannelClosed' | 'CloseRequested' | 'ChannelWithdrawn';
  args: unknown[];
  blockNumber: number;
  index: number;
  txHash?: string;
}

function buildLog(p: BuildLogParams) {
  const iface = new ethers.Interface(CHANNELS_ABI);
  const encoded = iface.encodeEventLog(p.event, p.args);
  return {
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: p.blockNumber,
    transactionHash: p.txHash ?? '0x' + '0'.repeat(64),
    index: p.index,
    address: CONTRACT_ADDRESS,
  };
}

describe('ChannelsClient.getChannelEvents', () => {
  it('decodes all five event types into the discriminated union', async () => {
    const logs = [
      buildLog({
        event: 'Reserved',
        args: [CHANNEL_ID, BUYER, SELLER, 1_000_000n],
        blockNumber: 10,
        index: 0,
      }),
      buildLog({
        event: 'ChannelSettled',
        args: [CHANNEL_ID, BUYER, SELLER, 50_000n, 50_000n, 50_000n, 100n, '0xdead'],
        blockNumber: 11,
        index: 0,
      }),
      buildLog({
        event: 'ChannelClosed',
        args: [CHANNEL_ID, BUYER, SELLER, 50_000n, 950_000n],
        blockNumber: 12,
        index: 0,
      }),
      buildLog({
        event: 'CloseRequested',
        args: [CHANNEL_ID, BUYER, SELLER, 1700000900n],
        blockNumber: 13,
        index: 0,
      }),
      buildLog({
        event: 'ChannelWithdrawn',
        args: [CHANNEL_ID, BUYER, SELLER, 900_000n],
        blockNumber: 14,
        index: 0,
      }),
    ];

    const client = makeClient();
    (client as unknown as { _provider: { getLogs: () => Promise<unknown[]> } })._provider.getLogs =
      async () => logs;

    const events = await client.getChannelEvents({ fromBlock: 0, toBlock: 100 });

    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ type: 'reserved', maxAmount: 1_000_000n });
    expect(events[1]).toMatchObject({
      type: 'settled',
      delta: 50_000n,
      totalSettled: 50_000n,
      platformFee: 100n,
    });
    expect(events[2]).toMatchObject({ type: 'closed', settledAmount: 50_000n, refund: 950_000n });
    expect(events[3]).toMatchObject({ type: 'closeRequested', gracePeriodEnd: 1700000900n });
    expect(events[4]).toMatchObject({ type: 'withdrawn', refund: 900_000n });

    // Common fields lowercased and preserved
    for (const evt of events) {
      expect(evt.channelId).toBe(CHANNEL_ID);
      expect(evt.buyer).toBe(BUYER.toLowerCase());
      expect(evt.seller).toBe(SELLER.toLowerCase());
    }
  });

  it('sorts events ascending by (blockNumber, logIndex)', async () => {
    const logs = [
      buildLog({ event: 'Reserved', args: [CHANNEL_ID, BUYER, SELLER, 1n], blockNumber: 5, index: 0 }),
      buildLog({ event: 'Reserved', args: [CHANNEL_ID, BUYER, SELLER, 2n], blockNumber: 3, index: 1 }),
      buildLog({ event: 'Reserved', args: [CHANNEL_ID, BUYER, SELLER, 3n], blockNumber: 3, index: 0 }),
    ];

    const client = makeClient();
    (client as unknown as { _provider: { getLogs: () => Promise<unknown[]> } })._provider.getLogs =
      async () => logs;

    const events = await client.getChannelEvents({ fromBlock: 0, toBlock: 10 });
    expect(events.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [3, 0],
      [3, 1],
      [5, 0],
    ]);
  });

  it('skips logs with unrecognized topics', async () => {
    const goodLog = buildLog({
      event: 'Reserved',
      args: [CHANNEL_ID, BUYER, SELLER, 7n],
      blockNumber: 1,
      index: 0,
    });
    const badLog = {
      ...goodLog,
      topics: ['0x' + 'de'.repeat(32), ...goodLog.topics.slice(1)],
    };

    const client = makeClient();
    (client as unknown as { _provider: { getLogs: () => Promise<unknown[]> } })._provider.getLogs =
      async () => [goodLog, badLog];

    const events = await client.getChannelEvents({ fromBlock: 0, toBlock: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('reserved');
  });
});
