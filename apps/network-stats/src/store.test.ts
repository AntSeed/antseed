/**
 * Unit tests for SqliteStore.
 *
 * Uses node:test (built-in) with in-memory SQLite (':memory:').
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore, bucketHistoryRows, ACTIVE_PEERS_UNKNOWN } from './store.js';
import type { DecodedMetadataRecorded } from '@antseed/node';

// ── helpers ───────────────────────────────────────────────────────────────────

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

// ── SqliteStore unit tests ────────────────────────────────────────────────────

describe('SqliteStore', () => {
  // Test 1: init is idempotent
  it('init is idempotent — call twice, no throw', () => {
    const store = new SqliteStore(':memory:');
    assert.doesNotThrow(() => {
      store.init();
      store.init();
    });

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
      .sort();

    assert.deepEqual(tables, [
      'indexer_checkpoint',
      'network_history',
      'peer_pricing_history',
      'seller_activity_history',
      'seller_buyer_totals',
      'seller_channel_totals',
      'seller_metadata_totals',
    ]);
    store.close();
  });

  // Test 2: getCheckpoint returns null before any write
  it('getCheckpoint returns null before any write', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const result = store.getCheckpoint('base', '0xdeadbeef');
    assert.equal(result, null);
    store.close();
  });

  // Test 3: applyBatch seeds a new agent
  it('applyBatch seeds a new agent with correct deltas and analytics', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const event = makeEvent({
      agentId: 42n,
      blockNumber: 1000,
      inputTokens: 100n,
      outputTokens: 200n,
      requestCount: 5n,
    });

    store.applyBatch('base', '0xcontract', [event], 10);

    const totals = store.getSellerTotals(42);
    assert.ok(totals !== null);
    assert.equal(totals.totalInputTokens, 100n);
    assert.equal(totals.totalOutputTokens, 200n);
    assert.equal(totals.totalRequests, 5n);
    assert.equal(totals.settlementCount, 1);
    assert.equal(totals.firstSettledBlock, 1000);
    assert.equal(totals.lastSettledBlock, 1000);
    assert.equal(totals.uniqueBuyers, 1);
    assert.equal(totals.uniqueChannels, 1);
    assert.equal(totals.avgRequestsPerBuyer, 5);
    assert.equal(totals.avgRequestsPerChannel, 5);
    store.close();
  });

  // Test 4: applyBatch accumulates across batches, BigInt correctness
  it('applyBatch accumulates across batches — BigInt correctness with large numbers', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const large = 10n ** 20n;

    const event1 = makeEvent({
      agentId: 7n,
      inputTokens: large,
      outputTokens: large * 2n,
      requestCount: large * 3n,
    });

    const event2 = makeEvent({
      agentId: 7n,
      inputTokens: large,
      outputTokens: large,
      requestCount: 1n,
    });

    store.applyBatch('base', '0xcontract', [event1], 5);
    store.applyBatch('base', '0xcontract', [event2], 10);

    const totals = store.getSellerTotals(7);
    assert.ok(totals !== null);
    assert.equal(totals.totalInputTokens, large * 2n);
    assert.equal(totals.totalOutputTokens, large * 3n);
    assert.equal(totals.totalRequests, large * 3n + 1n);
    store.close();
  });

  // Test 5: applyBatch advances the checkpoint
  it('applyBatch advances the checkpoint', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch('base', '0xcontract', [], 999);

    const checkpoint = store.getCheckpoint('base', '0xcontract');
    assert.equal(checkpoint, 999);
    store.close();
  });

  // Test 6: applyBatch rollback on mid-batch throw
  it('applyBatch rolls back atomically on error — checkpoint and prior agents unchanged', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    // Establish baseline: agent 1 has data, checkpoint at block 5
    const baseline = makeEvent({ agentId: 1n, inputTokens: 50n, outputTokens: 50n, requestCount: 1n });
    store.applyBatch('base', '0xcontract', [baseline], 5);

    // Verify baseline
    const beforeTotals = store.getSellerTotals(1);
    assert.ok(beforeTotals !== null);
    assert.equal(beforeTotals.totalInputTokens, 50n);

    // Now attempt a batch where the second event has a malformed field (string instead of bigint)
    // This will throw during BigInt arithmetic, rolling back the whole transaction.
    const goodEvent = makeEvent({ agentId: 2n, inputTokens: 100n, outputTokens: 100n, requestCount: 1n });
    const badEvent = makeEvent({ agentId: 3n, inputTokens: null as unknown as bigint });

    assert.throws(() => {
      store.applyBatch('base', '0xcontract', [goodEvent, badEvent], 99);
    });

    // Checkpoint should still be 5, not 99
    assert.equal(store.getCheckpoint('base', '0xcontract'), 5);

    // Agent 1 should be unchanged
    const afterTotals = store.getSellerTotals(1);
    assert.ok(afterTotals !== null);
    assert.equal(afterTotals.totalInputTokens, 50n);

    // Agent 2 should NOT have been written (rolled back)
    assert.equal(store.getSellerTotals(2), null);

    store.close();
  });

  // Test 7: Two different (chainId, contractAddress) checkpoints coexist
  it('two different (chainId, contractAddress) checkpoints coexist independently', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch('chain-a', '0xaaa', [], 100);
    store.applyBatch('chain-b', '0xbbb', [], 200);

    assert.equal(store.getCheckpoint('chain-a', '0xaaa'), 100);
    assert.equal(store.getCheckpoint('chain-b', '0xbbb'), 200);

    // Advance one without affecting the other
    store.applyBatch('chain-a', '0xaaa', [], 150);
    assert.equal(store.getCheckpoint('chain-a', '0xaaa'), 150);
    assert.equal(store.getCheckpoint('chain-b', '0xbbb'), 200);

    store.close();
  });

  // Test: unique buyers and channels counted across multiple events
  it('tracks unique buyers and channels per agent', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const buyerA = '0x' + 'a'.repeat(40);
    const buyerB = '0x' + 'b'.repeat(40);
    const channel1 = '0x' + '1'.repeat(64);
    const channel2 = '0x' + '2'.repeat(64);
    const channel3 = '0x' + '3'.repeat(64);

    store.applyBatch(
      'base',
      '0xcontract',
      [
        makeEvent({ agentId: 5n, buyer: buyerA, channelId: channel1, blockNumber: 10, requestCount: 3n }),
        makeEvent({ agentId: 5n, buyer: buyerA, channelId: channel2, blockNumber: 11, requestCount: 4n }),
        makeEvent({ agentId: 5n, buyer: buyerB, channelId: channel3, blockNumber: 12, requestCount: 5n }),
        // Repeat on channel1 — must NOT increase uniqueChannels
        makeEvent({ agentId: 5n, buyer: buyerA, channelId: channel1, blockNumber: 13, requestCount: 8n }),
      ],
      20,
    );

    const totals = store.getSellerTotals(5);
    assert.ok(totals !== null);
    assert.equal(totals.totalRequests, 20n);
    assert.equal(totals.settlementCount, 4);
    assert.equal(totals.uniqueBuyers, 2);
    assert.equal(totals.uniqueChannels, 3);
    assert.equal(totals.firstSettledBlock, 10);
    assert.equal(totals.lastSettledBlock, 13);
    assert.equal(totals.avgRequestsPerBuyer, 10); // 20 / 2
    assert.equal(totals.avgRequestsPerChannel, 6); // 20 / 3 → BigInt floor div
    store.close();
  });

  // Test: first_settled_block is set only on first insert, last_settled_block always advances
  it('first_settled_block is stable across batches, last_settled_block advances', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch(
      'base',
      '0xcontract',
      [makeEvent({ agentId: 9n, blockNumber: 500, requestCount: 1n })],
      500,
    );

    const after1 = store.getSellerTotals(9);
    assert.ok(after1 !== null);
    assert.equal(after1.firstSettledBlock, 500);
    assert.equal(after1.lastSettledBlock, 500);

    store.applyBatch(
      'base',
      '0xcontract',
      [makeEvent({ agentId: 9n, blockNumber: 750, requestCount: 1n })],
      750,
    );

    const after2 = store.getSellerTotals(9);
    assert.ok(after2 !== null);
    assert.equal(after2.firstSettledBlock, 500);
    assert.equal(after2.lastSettledBlock, 750);
    assert.equal(after2.settlementCount, 2);
    store.close();
  });

  // ── network_history ────────────────────────────────────────────────────────

  it('recordHistorySample + getHistory: 1d range buckets hourly with deltas + last-gauge', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const HOUR = 3600;
    // Anchor `now` exactly on an hour boundary so ts arithmetic below lands
    // each sample in the bucket we expect without surprise rounding.
    const now = Math.floor(1_700_000_000 / HOUR) * HOUR;

    // Two samples in the bucket [now-2h, now-1h), then two samples in
    // [now-1h, now). Cumulative grows monotonically; gauge fluctuates.
    store.recordHistorySample({
      ts: now - 90 * 60,      // 1.5 h ago — bucket A
      activePeers: 8,
      sellerCount: 2,
      totalRequests: 100n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 10,
    });
    store.recordHistorySample({
      ts: now - 75 * 60,      // 1.25 h ago — bucket A
      activePeers: 9,
      sellerCount: 2,
      totalRequests: 130n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 13,
    });
    store.recordHistorySample({
      ts: now - 45 * 60,      // 0.75 h ago — bucket B
      activePeers: 12,
      sellerCount: 3,
      totalRequests: 160n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 17,
    });
    store.recordHistorySample({
      ts: now - 15 * 60,      // 0.25 h ago — bucket B
      activePeers: 11,
      sellerCount: 3,
      totalRequests: 180n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 20,
    });

    const history = store.getHistory('1d', now);
    assert.equal(history.range, '1d');
    assert.equal(history.bucketSeconds, HOUR);
    assert.equal(history.points.length, 2);

    // Bucket A: baseline = own first (no prior bucket) → 130-100=30, 13-10=3;
    // gauge = last sample in bucket = 9.
    assert.equal(history.points[0]!.activePeers, 9);
    assert.equal(history.points[0]!.requests, 30);
    assert.equal(history.points[0]!.settlements, 3);

    // Bucket B: baseline = previous bucket's last cumulative (130, 13).
    // → 180-130=50; 20-13=7; gauge = last = 11.
    assert.equal(history.points[1]!.activePeers, 11);
    assert.equal(history.points[1]!.requests, 50);
    assert.equal(history.points[1]!.settlements, 7);

    store.close();
  });

  it('getHistory: 7d range buckets daily and excludes samples outside the window', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const now = 1_700_000_000;
    const DAY = 86400;

    // Sample 10 days ago — should be filtered out (outside 7d window).
    store.recordHistorySample({
      ts: now - 10 * DAY,
      activePeers: 1,
      sellerCount: 1,
      totalRequests: 1n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 1,
    });
    // Sample 3 days ago.
    store.recordHistorySample({
      ts: now - 3 * DAY,
      activePeers: 5,
      sellerCount: 2,
      totalRequests: 100n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 10,
    });
    // Sample 2 days ago.
    store.recordHistorySample({
      ts: now - 2 * DAY,
      activePeers: 6,
      sellerCount: 2,
      totalRequests: 150n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 15,
    });

    const history = store.getHistory('7d', now);
    assert.equal(history.bucketSeconds, DAY);
    // Two day-buckets, one each.
    assert.equal(history.points.length, 2);
    // First in-range bucket uses its own value as baseline → 0 delta.
    assert.equal(history.points[0]!.requests, 0);
    assert.equal(history.points[0]!.settlements, 0);
    // Second bucket: 150-100=50, 15-10=5.
    assert.equal(history.points[1]!.requests, 50);
    assert.equal(history.points[1]!.settlements, 5);
    store.close();
  });

  it('recordHistorySample is idempotent on duplicate ts (INSERT OR IGNORE)', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    const sample = {
      ts: 1_700_000_000,
      activePeers: 5,
      sellerCount: 1,
      totalRequests: 10n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 1,
    };

    assert.doesNotThrow(() => {
      store.recordHistorySample(sample);
      // Same ts, different peer count — must NOT throw and must NOT overwrite.
      store.recordHistorySample({ ...sample, activePeers: 99 });
    });

    const history = store.getHistory('1d', sample.ts);
    assert.equal(history.points.length, 1);
    assert.equal(history.points[0]!.activePeers, 5); // first write wins
    store.close();
  });

  it('bucketHistoryRows clamps negative deltas to zero', () => {
    // Pathological: cumulative counter goes DOWN (e.g. DB reset).
    // We clamp instead of letting a negative number reach the chart.
    const points = bucketHistoryRows(
      [
        { ts: 0,      active_peers: 1, seller_count: 1, total_requests: '500', total_input_tokens: '1000', total_output_tokens: '500', settlement_count: 50 },
        { ts: 86400,  active_peers: 1, seller_count: 1, total_requests: '100', total_input_tokens: '0',    total_output_tokens: '0',   settlement_count: 10 },
      ],
      86400,
    );
    assert.equal(points.length, 2);
    assert.equal(points[1]!.requests, 0);
    assert.equal(points[1]!.settlements, 0);
    assert.equal(points[1]!.tokens, 0);
  });

  it('bucketHistoryRows computes tokens delta as input+output across buckets', () => {
    // Two day-buckets. Tokens combine input + output cumulatively, and the
    // per-bucket delta is the change in that combined cumulative.
    const points = bucketHistoryRows(
      [
        // bucket 0: cumulative input=100, output=50 → tokens=150
        { ts: 0,       active_peers: 1, seller_count: 1, total_requests: '0', total_input_tokens: '100',  total_output_tokens: '50',  settlement_count: 0 },
        { ts: 3600,    active_peers: 1, seller_count: 1, total_requests: '0', total_input_tokens: '300',  total_output_tokens: '150', settlement_count: 0 },
        // bucket 1 (next day): cumulative input=1000, output=400 → tokens=1400
        { ts: 86400,   active_peers: 1, seller_count: 1, total_requests: '0', total_input_tokens: '1000', total_output_tokens: '400', settlement_count: 0 },
      ],
      86400,
    );
    assert.equal(points.length, 2);
    // First bucket: baseline = own first sample (150) → 450 - 150 = 300
    assert.equal(points[0]!.tokens, 300);
    // Second bucket: baseline = previous bucket's last (450) → 1400 - 450 = 950
    assert.equal(points[1]!.tokens, 950);
  });

  it('bucketHistoryRows: ACTIVE_PEERS_UNKNOWN sentinel becomes null on the way out', () => {
    const points = bucketHistoryRows(
      [
        // Backfilled bucket — only chain data, no DHT info.
        { ts: 0,      active_peers: ACTIVE_PEERS_UNKNOWN, seller_count: 1, total_requests: '50',  total_input_tokens: '0', total_output_tokens: '0', settlement_count: 5 },
        // Forward-sampled bucket with a real peer count.
        { ts: 86400,  active_peers: 7,                    seller_count: 2, total_requests: '120', total_input_tokens: '0', total_output_tokens: '0', settlement_count: 12 },
      ],
      86400,
    );
    assert.equal(points.length, 2);
    assert.equal(points[0]!.activePeers, null, 'backfilled bucket emits null peers');
    assert.equal(points[1]!.activePeers, 7);
    // Real samples take precedence within a single bucket — last-sample wins.
    const mixed = bucketHistoryRows(
      [
        { ts: 0, active_peers: ACTIVE_PEERS_UNKNOWN, seller_count: 1, total_requests: '0', total_input_tokens: '0', total_output_tokens: '0', settlement_count: 0 },
        { ts: 1, active_peers: 5,                    seller_count: 1, total_requests: '0', total_input_tokens: '0', total_output_tokens: '0', settlement_count: 0 },
      ],
      86400,
    );
    assert.equal(mixed[0]!.activePeers, 5, 'real peer sample later in bucket overrides earlier sentinel');
  });

  it('getEarliestHistoryTs returns null on empty table, then min(ts) once populated', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    assert.equal(store.getEarliestHistoryTs(), null);

    store.recordHistorySample({
      ts: 200,
      activePeers: 1,
      sellerCount: 1,
      totalRequests: 0n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 0,
    });
    store.recordHistorySample({
      ts: 100,
      activePeers: 1,
      sellerCount: 1,
      totalRequests: 0n,
      totalInputTokens: 0n,
      totalOutputTokens: 0n,
      settlementCount: 0,
    });

    assert.equal(store.getEarliestHistoryTs(), 100);
    store.close();
  });

  // Test: Checkpoint key is case-insensitive on contract_address
  it('checkpoint contract_address key is case-insensitive', () => {
    const store = new SqliteStore(':memory:');
    store.init();

    store.applyBatch('chain', '0xAbC', [], 42);

    // Both lookups should return the same value regardless of case
    const lower = store.getCheckpoint('chain', '0xabc');
    const upper = store.getCheckpoint('chain', '0xABC');
    const mixed = store.getCheckpoint('chain', '0xAbC');

    assert.equal(lower, 42);
    assert.equal(upper, 42);
    assert.equal(mixed, 42);

    store.close();
  });

  // ── pricing history ──────────────────────────────────────────────────────

  it('recordPriceSample dedups when prices match the latest stored row', () => {
    const store = new SqliteStore(':memory:');
    store.init();
    const baseSample = {
      peerId: 'aa', provider: 'p', service: 's',
      inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    };
    store.recordPriceSample({ ...baseSample, ts: 100 });
    // Identical price at a later ts → no new row.
    store.recordPriceSample({ ...baseSample, ts: 200 });
    // Changed price → new row.
    store.recordPriceSample({ ...baseSample, ts: 300, inputUsdPerMillion: 5 });

    const rollup = store.getPriceVolatility(0);
    assert.equal(rollup.length, 1);
    assert.equal(rollup[0]!.sampleCount, 2);
    assert.equal(rollup[0]!.changeCount, 2);
    assert.equal(rollup[0]!.firstInputUsdPerMillion, 1);
    assert.equal(rollup[0]!.latestInputUsdPerMillion, 5);
    store.close();
  });

  it('recordPriceSample writes daily heartbeats for unchanged prices', () => {
    const store = new SqliteStore(':memory:');
    store.init();
    const DAY = 86400;
    const baseSample = {
      peerId: 'aa', provider: 'p', service: 's',
      inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    };
    store.recordPriceSample({ ...baseSample, ts: 100 });
    store.recordPriceSample({ ...baseSample, ts: 100 + DAY - 1 });
    store.recordPriceSample({ ...baseSample, ts: 100 + DAY });

    const rollup = store.getPriceVolatility(100 + 3600);
    assert.equal(rollup.length, 1);
    assert.equal(rollup[0]!.sampleCount, 1);
    assert.equal(rollup[0]!.changeCount, 1);
    assert.equal(rollup[0]!.firstInputUsdPerMillion, 1);
    assert.equal(rollup[0]!.latestInputUsdPerMillion, 1);
    store.close();
  });

  it('getPriceVolatility window excludes samples before sinceSec', () => {
    const store = new SqliteStore(':memory:');
    store.init();
    store.recordPriceSample({ peerId: 'aa', provider: 'p', service: 's', ts: 100, inputUsdPerMillion: 1, outputUsdPerMillion: 1 });
    store.recordPriceSample({ peerId: 'aa', provider: 'p', service: 's', ts: 500, inputUsdPerMillion: 2, outputUsdPerMillion: 2 });
    const rollup = store.getPriceVolatility(400);
    assert.equal(rollup.length, 1);
    assert.equal(rollup[0]!.sampleCount, 1);
    assert.equal(rollup[0]!.firstInputUsdPerMillion, 2);
    store.close();
  });

  // ── seller activity history ──────────────────────────────────────────────

  it('recordSellerActivitySample dedups when totals match the latest stored row', () => {
    const store = new SqliteStore(':memory:');
    store.init();
    store.recordSellerActivitySample({
      agentId: 1, ts: 100, totalRequests: 10n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 3,
    });
    // No change → not stored.
    store.recordSellerActivitySample({
      agentId: 1, ts: 200, totalRequests: 10n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 3,
    });
    // New settlement → stored.
    store.recordSellerActivitySample({
      agentId: 1, ts: 300, totalRequests: 15n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 4,
    });
    const rows = store.getSellerActivitySince(0);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.ts, 100);
    assert.equal(rows[1]!.ts, 300);
    assert.equal(rows[1]!.totalRequests, 15n);
    store.close();
  });

  it('getSellerActivityForTrending includes the latest pre-window baseline per active agent', () => {
    const store = new SqliteStore(':memory:');
    store.init();
    store.recordSellerActivitySample({
      agentId: 1, ts: 100, totalRequests: 10n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 1,
    });
    store.recordSellerActivitySample({
      agentId: 1, ts: 250, totalRequests: 20n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 2,
    });
    store.recordSellerActivitySample({
      agentId: 1, ts: 300, totalRequests: 30n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 3,
    });
    store.recordSellerActivitySample({
      agentId: 2, ts: 150, totalRequests: 99n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 1,
    });

    const rows = store.getSellerActivityForTrending(200);
    assert.deepEqual(
      rows.map((row) => [row.agentId, row.ts, row.totalRequests.toString()]),
      [
        [1, 100, '10'],
        [1, 250, '20'],
        [1, 300, '30'],
      ],
    );
    store.close();
  });
});
