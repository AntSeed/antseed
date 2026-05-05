/**
 * Unit tests for backfillNetworkHistory.
 *
 * We inject in-process fakes for both StatsClient and the block-timestamp
 * provider so the test exercises the day-bucket walker without chain or RPC.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore, ACTIVE_PEERS_UNKNOWN } from './store.js';
import { backfillNetworkHistory } from './backfill.js';
import type { DecodedMetadataRecorded } from '@antseed/node';

const DAY = 86_400;

function ev(overrides: Partial<DecodedMetadataRecorded> = {}): DecodedMetadataRecorded {
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

function makeStatsClient(events: DecodedMetadataRecorded[], head = 10_000) {
  return {
    async getBlockNumber() {
      return head;
    },
    async getMetadataRecordedEvents(p: { fromBlock: number; toBlock: number }) {
      return events
        .filter((e) => e.blockNumber >= p.fromBlock && e.blockNumber <= p.toBlock)
        .sort((a, b) =>
          a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
        );
    },
  };
}

function makeProvider(blockTs: Map<number, number>) {
  return {
    async getBlock(n: number) {
      const ts = blockTs.get(n);
      return ts === undefined ? null : { timestamp: ts };
    },
  };
}

describe('backfillNetworkHistory', () => {
  it('writes one row per day with cumulative totals + ACTIVE_PEERS_UNKNOWN sentinel', async () => {
    const day0 = Math.floor(1_700_000_000 / DAY) * DAY; // an arbitrary UTC day boundary
    // Two events on day 0, one event on day 1.
    const events: DecodedMetadataRecorded[] = [
      ev({ blockNumber: 100, logIndex: 0, agentId: 1n, requestCount: 3n, inputTokens: 30n, outputTokens: 10n }),
      ev({ blockNumber: 110, logIndex: 0, agentId: 2n, requestCount: 5n, inputTokens: 50n, outputTokens: 20n }),
      ev({ blockNumber: 200, logIndex: 0, agentId: 1n, requestCount: 2n, inputTokens: 20n, outputTokens: 5n  }),
    ];
    const blockTs = new Map<number, number>([
      [100, day0 + 100],
      [110, day0 + 200],
      [200, day0 + DAY + 50],
    ]);

    const store = new SqliteStore(':memory:');
    store.init();

    await backfillNetworkHistory({
      store,
      statsClient: makeStatsClient(events, 5_000),
      provider: makeProvider(blockTs),
      deployBlock: 0,
      reorgSafetyBlocks: 0,
      maxBlocksPerChunk: 10_000,
    });

    // Read back via getHistory with a 30d range so both day buckets are in scope.
    const hist = store.getHistory('30d', day0 + 2 * DAY);
    assert.equal(hist.points.length, 2);

    // Day-0 bucket: cum requests 3+5=8, settlements 2, sellers {1,2}=2, peers null.
    assert.equal(hist.points[0]!.activePeers, null);
    // First bucket: baseline = own first sample → delta = 0.
    assert.equal(hist.points[0]!.requests, 0);

    // Day-1 bucket: prev cumulative (8 req, 2 settlements) → delta = 2 req, 1 settlement.
    assert.equal(hist.points[1]!.activePeers, null);
    assert.equal(hist.points[1]!.requests, 2);
    assert.equal(hist.points[1]!.settlements, 1);
    // Tokens: prev cum (30+10+50+20)=110, current cum (110+20+5)=135, delta=25.
    assert.equal(hist.points[1]!.tokens, 25);

    store.close();
  });

  it('is idempotent — re-running with same events writes no additional rows', async () => {
    const day0 = Math.floor(1_700_000_000 / DAY) * DAY;
    const events: DecodedMetadataRecorded[] = [
      ev({ blockNumber: 100, agentId: 1n, requestCount: 1n }),
    ];
    const blockTs = new Map<number, number>([[100, day0 + 100]]);
    const store = new SqliteStore(':memory:');
    store.init();
    const sc = makeStatsClient(events, 5_000);

    const provider = makeProvider(blockTs);
    const r1 = await backfillNetworkHistory({
      store,
      statsClient: sc,
      provider,
      deployBlock: 0,
      reorgSafetyBlocks: 0,
      maxBlocksPerChunk: 10_000,
    });
    assert.equal(r1.rowsWritten, 1);

    const r2 = await backfillNetworkHistory({
      store,
      statsClient: sc,
      provider,
      deployBlock: 0,
      reorgSafetyBlocks: 0,
      maxBlocksPerChunk: 10_000,
    });
    // Second run still reports rowsWritten=1 (we attempted one INSERT) but
    // INSERT OR IGNORE silently dropped it — the table still has only one row.
    assert.equal(r2.rowsWritten, 1);

    const ph = store.getHistory('30d', day0 + DAY);
    assert.equal(ph.points.length, 1);
    assert.equal(ph.points[0]!.activePeers, null);
    store.close();
  });

  it('returns 0 rows when contract has no events yet', async () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const result = await backfillNetworkHistory({
      store,
      statsClient: makeStatsClient([], 5_000),
      provider: makeProvider(new Map()),
      deployBlock: 0,
      reorgSafetyBlocks: 0,
      maxBlocksPerChunk: 10_000,
    });
    assert.equal(result.events, 0);
    assert.equal(result.rowsWritten, 0);
    store.close();
  });

  // Sanity: ACTIVE_PEERS_UNKNOWN is the sentinel the chart relies on. Lock it in.
  it('exports ACTIVE_PEERS_UNKNOWN = -1', () => {
    assert.equal(ACTIVE_PEERS_UNKNOWN, -1);
  });
});
