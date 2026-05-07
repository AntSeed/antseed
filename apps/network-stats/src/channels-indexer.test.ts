import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ChannelsClient, DecodedChannelEvent } from '@antseed/node';
import { SqliteStore } from './store.js';
import { ChannelsIndexer } from './channels-indexer.js';

function makeMockClient(opts: {
  blockNumber: number;
  events?: DecodedChannelEvent[];
  throwOnFetch?: boolean;
}): {
  client: Pick<ChannelsClient, 'getChannelEvents' | 'getBlockNumber'>;
  fetchCalls: Array<{ fromBlock: number; toBlock: number }>;
} {
  const fetchCalls: Array<{ fromBlock: number; toBlock: number }> = [];
  const client = {
    async getBlockNumber() {
      return opts.blockNumber;
    },
    async getChannelEvents(p: { fromBlock: number; toBlock: number }) {
      fetchCalls.push(p);
      if (opts.throwOnFetch) throw new Error('forced');
      return opts.events ?? [];
    },
  };
  return { client, fetchCalls };
}

function settledEvt(over: Partial<DecodedChannelEvent> = {}): DecodedChannelEvent {
  return {
    type: 'settled',
    blockNumber: 1,
    logIndex: 0,
    txHash: '0x' + '0'.repeat(64),
    channelId: '0x' + '1'.repeat(64),
    buyer: '0x' + 'b'.repeat(40),
    seller: '0x' + 'a'.repeat(40),
    cumulativeAmount: 0n,
    delta: 0n,
    totalSettled: 0n,
    platformFee: 0n,
    ...over,
  } as DecodedChannelEvent;
}

function makeStore(): SqliteStore {
  const store = new SqliteStore(':memory:');
  store.init();
  return store;
}

const CHAIN_ID = 'base-mainnet';
const CONTRACT = '0xchannels';

describe('ChannelsIndexer', () => {
  it('cold start reads from deployBlock', async () => {
    const store = makeStore();
    const { client, fetchCalls } = makeMockClient({ blockNumber: 150 });
    const indexer = new ChannelsIndexer({
      store,
      channelsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 100,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer.tick();

    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(fetchCalls[0], { fromBlock: 100, toBlock: 138 });
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), 138);
    store.close();
  });

  it('persists settled events into lifetime aggregates', async () => {
    const store = makeStore();
    const seller = '0x' + 'c'.repeat(40);
    const events = [
      settledEvt({ blockNumber: 50, logIndex: 0, seller, delta: 100n, totalSettled: 100n }),
      settledEvt({ blockNumber: 51, logIndex: 0, seller, delta: 250n, totalSettled: 350n }),
    ];

    const { client } = makeMockClient({ blockNumber: 100, events });
    const indexer = new ChannelsIndexer({
      store,
      channelsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer.tick();

    const lifetime = store.getAllSellerChannelLifetime().get(seller)!;
    assert.equal(lifetime.settledCount, 2);
    assert.equal(lifetime.totalUsdcSettled, 350n);
    store.close();
  });

  it('mid-tick throw leaves the checkpoint unchanged', async () => {
    const store = makeStore();
    const { client } = makeMockClient({ blockNumber: 200, throwOnFetch: true });
    const indexer = new ChannelsIndexer({
      store,
      channelsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await assert.doesNotReject(() => indexer.tick());
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), null);
    store.close();
  });

  it('does nothing when latest - reorgSafetyBlocks < deployBlock', async () => {
    const store = makeStore();
    const { client, fetchCalls } = makeMockClient({ blockNumber: 1005 });
    const indexer = new ChannelsIndexer({
      store,
      channelsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 1000,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer.tick();
    assert.equal(fetchCalls.length, 0);
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), null);
    store.close();
  });

  it('throws if deployBlock < 0', () => {
    const store = makeStore();
    const { client } = makeMockClient({ blockNumber: 100 });

    assert.throws(
      () => new ChannelsIndexer({
        store,
        channelsClient: client,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        deployBlock: -1,
        tickIntervalMs: 60_000,
        reorgSafetyBlocks: 12,
      }),
      /deployBlock/,
    );
    store.close();
  });
});
