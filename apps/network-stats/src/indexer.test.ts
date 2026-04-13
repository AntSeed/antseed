import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DecodedMetadataRecorded } from '@antseed/node';
import { SqliteStore } from './store.js';
import { MetadataIndexer } from './indexer.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockClient(opts: {
  blockNumber: number;
  events?: DecodedMetadataRecorded[];
  throwOnFetch?: boolean;
}): {
  client: Pick<import('@antseed/node').StatsClient, 'getMetadataRecordedEvents' | 'getBlockNumber'>;
  fetchCalls: Array<{ fromBlock: number; toBlock: number }>;
} {
  const fetchCalls: Array<{ fromBlock: number; toBlock: number }> = [];
  const client = {
    async getBlockNumber() {
      return opts.blockNumber;
    },
    async getMetadataRecordedEvents(p: { fromBlock: number; toBlock: number }) {
      fetchCalls.push(p);
      if (opts.throwOnFetch) throw new Error('forced');
      return opts.events ?? [];
    },
  };
  return { client, fetchCalls };
}

function makeEvent(overrides: Partial<DecodedMetadataRecorded> = {}): DecodedMetadataRecorded {
  return {
    blockNumber: 1,
    txHash: '0x' + '0'.repeat(64),
    logIndex: 0,
    agentId: 1n,
    buyer: '0x' + '0'.repeat(40),
    channelId: '0x' + '1'.repeat(64),
    metadataHash: '0x' + '2'.repeat(64),
    inputTokens: 0n,
    outputTokens: 0n,
    requestCount: 0n,
    ...overrides,
  };
}

function makeStore(): SqliteStore {
  const store = new SqliteStore(':memory:');
  store.init();
  return store;
}

const CHAIN_ID = 'base-mainnet';
const CONTRACT = '0xdeadbeef';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MetadataIndexer', () => {

  // Case 1: Cold start reads from deployBlock
  it('cold start reads from deployBlock', async () => {
    const store = makeStore();
    const deployBlock = 100;
    const { client, fetchCalls } = makeMockClient({ blockNumber: deployBlock + 50 }); // latest=150, safeTo=138

    const indexer = new MetadataIndexer({
      store,
      statsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer.tick();

    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(fetchCalls[0], { fromBlock: 100, toBlock: 138 });

    const checkpoint = store.getCheckpoint(CHAIN_ID, CONTRACT);
    assert.equal(checkpoint, 138);

    store.close();
  });

  // Case 2: Steady state advances by reorg-safe range
  it('steady state advances by reorg-safe range', async () => {
    const store = makeStore();
    // Pre-seed checkpoint at 100
    store.applyBatch(CHAIN_ID, CONTRACT, [], 100);

    const { client, fetchCalls } = makeMockClient({ blockNumber: 200 }); // safeTo=188

    const indexer = new MetadataIndexer({
      store,
      statsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer.tick();

    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(fetchCalls[0], { fromBlock: 101, toBlock: 188 });

    store.close();
  });

  // Case 3: Nothing to do — checkpoint 188, latest 195, safety 12 => safeTo=183 < fromBlock=189
  it('nothing to do when safeTo < fromBlock', async () => {
    const store = makeStore();
    store.applyBatch(CHAIN_ID, CONTRACT, [], 188);

    const { client, fetchCalls } = makeMockClient({ blockNumber: 195 }); // safeTo=183

    const indexer = new MetadataIndexer({
      store,
      statsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer.tick();

    assert.equal(fetchCalls.length, 0);
    const checkpoint = store.getCheckpoint(CHAIN_ID, CONTRACT);
    assert.equal(checkpoint, 188);

    store.close();
  });

  // Case 4: Paging across maxBlocksPerTick
  it('pages across maxBlocksPerTick correctly', async () => {
    const store = makeStore();
    const deployBlock = 0;

    // Use a single mock client that always returns blockNumber=5000
    const { client, fetchCalls } = makeMockClient({ blockNumber: 5000 }); // safeTo=4988

    const indexer = new MetadataIndexer({
      store,
      statsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
      maxBlocksPerTick: 2000,
    });

    // Tick 1: fromBlock=0, toBlock=min(4988, 0+1999)=1999 → range 0..1999
    await indexer.tick();
    assert.deepEqual(fetchCalls[0], { fromBlock: 0, toBlock: 1999 });
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), 1999);

    // Tick 2: fromBlock=2000, toBlock=min(4988, 2000+1999)=3999 → range 2000..3999
    await indexer.tick();
    assert.deepEqual(fetchCalls[1], { fromBlock: 2000, toBlock: 3999 });
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), 3999);

    // Tick 3: fromBlock=4000, toBlock=min(4988, 4000+1999)=4988 → range 4000..4988
    await indexer.tick();
    assert.deepEqual(fetchCalls[2], { fromBlock: 4000, toBlock: 4988 });
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), 4988);

    // Tick 4: fromBlock=4989 > safeTo=4988 → no-op
    await indexer.tick();
    assert.equal(fetchCalls.length, 3);

    store.close();
  });

  // Case 5: Deltas accumulate across ticks for same agent
  it('deltas accumulate across ticks for same agentId', async () => {
    const store = makeStore();
    const agentId = 42n;

    // Two separate mock clients, each returning events for the same agent
    const event1 = makeEvent({ agentId, inputTokens: 100n, outputTokens: 200n, requestCount: 3n, blockNumber: 10 });
    const event2 = makeEvent({ agentId, inputTokens: 50n, outputTokens: 75n, requestCount: 2n, blockNumber: 60 });

    const { client: client1, fetchCalls: calls1 } = makeMockClient({
      blockNumber: 100,
      events: [event1],
    });
    // safeTo=88, fromBlock=0, toBlock=min(88,0+1999)=88
    const indexer1 = new MetadataIndexer({
      store,
      statsClient: client1,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });
    await indexer1.tick();
    assert.equal(calls1.length, 1);

    // Now checkpoint=88; second tick with different client returning event2
    const { client: client2, fetchCalls: calls2 } = makeMockClient({
      blockNumber: 200,
      events: [event2],
    });
    // safeTo=188, fromBlock=89, toBlock=min(188,89+1999)=188
    const indexer2 = new MetadataIndexer({
      store,
      statsClient: client2,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });
    await indexer2.tick();
    assert.equal(calls2.length, 1);

    const totals = store.getSellerTotals(Number(agentId));
    assert.ok(totals !== null);
    assert.equal(totals!.totalInputTokens, 150n);    // 100 + 50
    assert.equal(totals!.totalOutputTokens, 275n);   // 200 + 75
    assert.equal(totals!.totalRequests, 5n);         // 3 + 2

    store.close();
  });

  // Case 6: Mid-tick throw leaves state unchanged
  it('mid-tick throw leaves checkpoint unchanged and does not reject', async () => {
    const store = makeStore();

    // Tick 1: fetch throws
    const throwingClient = makeMockClient({ blockNumber: 200, throwOnFetch: true });
    const indexer = new MetadataIndexer({
      store,
      statsClient: throwingClient.client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    // tick() must NOT reject — promise resolves
    await assert.doesNotReject(() => indexer.tick());

    // Checkpoint must still be null (not advanced)
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), null);

    // Tick 2: working client — must process the SAME range that was skipped
    const { client: workingClient, fetchCalls } = makeMockClient({ blockNumber: 200 }); // safeTo=188
    const indexer2 = new MetadataIndexer({
      store,
      statsClient: workingClient,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer2.tick();
    // fromBlock should be 0 (same range as the failed tick)
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.fromBlock, 0);
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), 188);

    store.close();
  });

  // Case 7: Chain behind safety window — cold start
  it('does nothing when latest - reorgSafetyBlocks < deployBlock', async () => {
    const store = makeStore();
    const deployBlock = 1000;

    // latest=1005, reorgSafetyBlocks=12, safeTo=993 < deployBlock=1000
    const { client, fetchCalls } = makeMockClient({ blockNumber: 1005 });

    const indexer = new MetadataIndexer({
      store,
      statsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
    });

    await indexer.tick();

    assert.equal(fetchCalls.length, 0);
    assert.equal(store.getCheckpoint(CHAIN_ID, CONTRACT), null);

    store.close();
  });

  // Constructor validation tests
  it('throws if deployBlock < 0', () => {
    const store = makeStore();
    const { client } = makeMockClient({ blockNumber: 100 });

    assert.throws(
      () => new MetadataIndexer({
        store,
        statsClient: client,
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

  it('throws if tickIntervalMs <= 0', () => {
    const store = makeStore();
    const { client } = makeMockClient({ blockNumber: 100 });

    assert.throws(
      () => new MetadataIndexer({
        store,
        statsClient: client,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        deployBlock: 0,
        tickIntervalMs: 0,
        reorgSafetyBlocks: 12,
      }),
      /tickIntervalMs/,
    );

    store.close();
  });

  it('defaults maxBlocksPerTick to 2000 when not provided', async () => {
    const store = makeStore();

    // latest=10000, safeTo=9988; no maxBlocksPerTick → should cap at 2000
    const { client, fetchCalls } = makeMockClient({ blockNumber: 10000 });

    const indexer = new MetadataIndexer({
      store,
      statsClient: client,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 0,
      tickIntervalMs: 60_000,
      reorgSafetyBlocks: 12,
      // maxBlocksPerTick intentionally omitted
    });

    await indexer.tick();

    assert.equal(fetchCalls.length, 1);
    // toBlock = min(9988, 0 + 2000 - 1) = 1999
    assert.deepEqual(fetchCalls[0], { fromBlock: 0, toBlock: 1999 });

    store.close();
  });
});
