/**
 * Integration tests for createServer — enriched /stats endpoint.
 *
 * Uses node:test (built-in). Boots real createServer instances with
 * in-memory SqliteStore and fake StakingClient / NetworkPoller stubs.
 *
 * Port strategy: unique-port approach — each test suite uses a fixed but unique
 * port in the 15000–15999 range to avoid conflicts.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from './server.js';
import { SqliteStore } from './store.js';
import type { NetworkPoller } from './poller.js';
import type { StakingClient, DecodedMetadataRecorded } from '@antseed/node';

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

// ── helpers ───────────────────────────────────────────────────────────────────

// peerId is the lowercased seller EVM address without the 0x prefix.
// Tests pass either a 0x-prefixed address or undefined; we strip the prefix
// so the field looks like it does on the wire.
function fakePeer(_id: string, address: string | undefined) {
  const peerId = address === undefined ? undefined : address.replace(/^0x/, '');
  const peer: Record<string, unknown> = {
    peerId,
    providers: [],
    region: 'eu-west-1',
    timestamp: 1700000000000,
    signature: 'sig',
    version: 'v1',
  };
  return peer;
}

function makePoller(peers: Record<string, unknown>[]): NetworkPoller {
  return {
    getSnapshot: () => ({ peers: peers as never[], updatedAt: '2026-01-01T00:00:00.000Z' }),
  } as unknown as NetworkPoller;
}

function makeStakingClient(
  lookup: (addr: string) => number | Promise<number>,
  counter?: { calls: number },
): StakingClient {
  return {
    getAgentId: async (addr: string) => {
      if (counter) counter.calls++;
      return lookup(addr);
    },
  } as unknown as StakingClient;
}

// In-memory store helper — creates and initialises a fresh store each time
function makeStore(): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.init();
  return s;
}

// ── Suite helpers ─────────────────────────────────────────────────────────────

let portSeed = 15000;

function nextPort(): number {
  return portSeed++;
}

// ── Test 1: Legacy path ───────────────────────────────────────────────────────

describe('createServer — legacy path (no store/stakingClient)', () => {
  const PORT = nextPort();
  const peers = [fakePeer('1', '0xaaa'), fakePeer('2', undefined)];
  const poller = makePoller(peers);
  const handle = createServer({ poller, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); });
  it('GET /stats returns snapshot shape without onChainStats', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    assert.equal(res.status, 200);
    const body = await res.json() as { peers: Record<string, unknown>[]; updatedAt: string };
    assert.ok(Array.isArray(body.peers));
    assert.equal(typeof body.updatedAt, 'string');
    for (const peer of body.peers) {
      assert.equal(Object.hasOwn(peer, 'onChainStats'), false, 'legacy path must not add onChainStats key');
    }
  });
});

// ── Test 2: Enriched — agent with totals ─────────────────────────────────────

describe('createServer — enriched: agent with totals', () => {
  const PORT = nextPort();
  const store = makeStore();
  // Seed totals for agentId 42
  store.applyBatch('test', '0xcontract', [
    makeEvent({ agentId: 42n, blockNumber: 100, inputTokens: 100n, outputTokens: 200n, requestCount: 5n }),
  ], 1);
  const peers = [fakePeer('a', '0xabc1234')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 42);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  it('peer has onChainStats with correct values including analytics', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as {
      peers: Array<{
        onChainStats: {
          agentId: number;
          totalRequests: string;
          totalInputTokens: string;
          totalOutputTokens: string;
          settlementCount: number;
          uniqueBuyers: number;
          uniqueChannels: number;
          firstSettledBlock: number;
          lastSettledBlock: number;
          avgRequestsPerBuyer: number;
          avgRequestsPerChannel: number;
          lastUpdatedAt: number;
        } | null;
      }>;
      totals: {
        totalRequests: string;
        totalInputTokens: string;
        totalOutputTokens: string;
        settlementCount: number;
        sellerCount: number;
      };
    };
    assert.equal(body.peers.length, 1);
    const stats = body.peers[0]!.onChainStats;
    assert.ok(stats !== null, 'onChainStats should not be null');
    assert.equal(stats!.agentId, 42);
    assert.equal(stats!.totalRequests, '5');
    assert.equal(stats!.totalInputTokens, '100');
    assert.equal(stats!.totalOutputTokens, '200');
    assert.equal(stats!.settlementCount, 1);
    assert.equal(stats!.uniqueBuyers, 1);
    assert.equal(stats!.uniqueChannels, 1);
    assert.equal(stats!.firstSettledBlock, 100);
    assert.equal(stats!.lastSettledBlock, 100);
    assert.equal(stats!.avgRequestsPerBuyer, 5);
    assert.equal(stats!.avgRequestsPerChannel, 5);
    assert.equal(typeof stats!.lastUpdatedAt, 'number');
    assert.equal(body.totals.totalRequests, '5');
    assert.equal(body.totals.totalInputTokens, '100');
    assert.equal(body.totals.totalOutputTokens, '200');
    assert.equal(body.totals.settlementCount, 1);
    assert.equal(body.totals.sellerCount, 1);
  });
});

// ── Test 3: Enriched — contract-backed peer uses sellerContract ───────────────

describe('createServer — enriched: contract-backed peer uses sellerContract', () => {
  const PORT = nextPort();
  const store = makeStore();
  store.applyBatch('test', '0xcontract', [
    makeEvent({ agentId: 77n, blockNumber: 101, inputTokens: 123n, outputTokens: 456n, requestCount: 7n }),
  ], 1);
  const peer = fakePeer('contract', '0xoperator');
  peer.sellerContract = '1f228613116e2d08014dfdcc198377c8dedf18c9';
  const peers = [peer];
  const poller = makePoller(peers);
  const seen: string[] = [];
  const stakingClient = makeStakingClient((addr) => {
    seen.push(addr);
    return addr === '0x1f228613116e2d08014dfdcc198377c8dedf18c9' ? 77 : 0;
  });
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => {
    seen.length = 0;
  });

  it('resolves stats by sellerContract instead of operator peerId', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as { peers: Array<{ onChainStats: { agentId: number; totalInputTokens: string; totalOutputTokens: string } | null }> };
    assert.deepEqual(seen, ['0x1f228613116e2d08014dfdcc198377c8dedf18c9']);
    const stats = body.peers[0]!.onChainStats;
    assert.ok(stats !== null, 'onChainStats should not be null');
    assert.equal(stats!.agentId, 77);
    assert.equal(stats!.totalInputTokens, '123');
    assert.equal(stats!.totalOutputTokens, '456');
  });
});

// ── Test 4: Enriched — network totals include inactive sellers ────────────────

describe('createServer — enriched: network totals include inactive sellers', () => {
  const PORT = nextPort();
  const store = makeStore();
  store.applyBatch('test', '0xcontract', [
    makeEvent({ agentId: 88n, blockNumber: 102, inputTokens: 10n, outputTokens: 20n, requestCount: 1n }),
    makeEvent({ agentId: 99n, blockNumber: 103, inputTokens: 30n, outputTokens: 40n, requestCount: 2n }),
  ], 1);
  const peers = [fakePeer('active', '0xactive')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 88);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  it('returns aggregate totals across all indexed sellers, not just active peers', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as {
      peers: Array<{ onChainStats: { agentId: number; totalInputTokens: string; totalOutputTokens: string } | null }>;
      totals: { totalRequests: string; totalInputTokens: string; totalOutputTokens: string; settlementCount: number; sellerCount: number };
    };

    assert.equal(body.peers[0]!.onChainStats?.agentId, 88);
    assert.equal(body.peers[0]!.onChainStats?.totalInputTokens, '10');
    assert.equal(body.peers[0]!.onChainStats?.totalOutputTokens, '20');
    assert.equal(body.totals.totalRequests, '3');
    assert.equal(body.totals.totalInputTokens, '40');
    assert.equal(body.totals.totalOutputTokens, '60');
    assert.equal(body.totals.settlementCount, 2);
    assert.equal(body.totals.sellerCount, 2);
  });
});

// ── Test 5: Enriched — agent with no events ───────────────────────────────────

describe('createServer — enriched: agent with no events in store', () => {
  const PORT = nextPort();
  const store = makeStore(); // empty store
  const peers = [fakePeer('b', '0xdef5678')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 43);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  it('peer has onChainStats: null when store has no row', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as { peers: Array<{ onChainStats: unknown }> };
    assert.equal(body.peers[0]!.onChainStats, null);
  });
});

// ── Test 6: Enriched — unstaked peer (agentId = 0) ────────────────────────────

describe('createServer — enriched: unstaked peer returns agentId 0', () => {
  const PORT = nextPort();
  const store = makeStore();
  const peers = [fakePeer('c', '0x000unstaked')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 0);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  it('peer has onChainStats: null when agentId is 0', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as { peers: Array<{ onChainStats: unknown }> };
    assert.equal(body.peers[0]!.onChainStats, null);
  });
});

// ── Test 7: Enriched — missing peerId ────────────────────────────────────────

describe('createServer — enriched: peer missing peerId', () => {
  const PORT = nextPort();
  const store = makeStore();
  const peers = [fakePeer('d', undefined)]; // no peerId
  const poller = makePoller(peers);
  const counter = { calls: 0 };
  const stakingClient = makeStakingClient(() => 99, counter);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => {
    counter.calls = 0;
  });

  it('peer has onChainStats: null and getAgentId is NOT called', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as { peers: Array<{ onChainStats: unknown }> };
    assert.equal(body.peers[0]!.onChainStats, null);
    assert.equal(counter.calls, 0, 'getAgentId must not be called when peerId is missing');
  });
});

// ── Test 8: Cache is reused ───────────────────────────────────────────────────

describe('createServer — enriched: cache reused across requests', () => {
  const PORT = nextPort();
  const store = makeStore();
  const peers = [
    fakePeer('e1', '0xaddr1'),
    fakePeer('e2', '0xaddr2'),
    fakePeer('e3', '0xaddr3'),
  ];
  const poller = makePoller(peers);
  const counter = { calls: 0 };
  // All return agentId=0 (unstaked) — we only care about call count
  const stakingClient = makeStakingClient(() => 0, counter);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => {
    counter.calls = 0;
  });

  it('getAgentId called exactly 3 times across 2 requests (cache hit on second)', async () => {
    // First request: populates cache for all 3 addresses
    await fetch(`http://localhost:${PORT}/stats`);
    assert.equal(counter.calls, 3, 'first request should call getAgentId 3 times');

    // Second request: all 3 addresses are cached
    await fetch(`http://localhost:${PORT}/stats`);
    assert.equal(counter.calls, 3, 'second request should not call getAgentId again (cache hit)');
  });
});

// ── Test 8a: Cache is scoped per server instance ─────────────────────────────

describe('createServer — enriched: cache isolation', () => {
  it('does not share agentId cache entries across createServer calls', async () => {
    const port1 = nextPort();
    const port2 = nextPort();
    const peers = [fakePeer('shared', '0xshared')];
    const poller = makePoller(peers);
    const store1 = makeStore();
    const store2 = makeStore();
    const counter1 = { calls: 0 };
    const counter2 = { calls: 0 };
    const handle1 = createServer({
      poller,
      store: store1,
      stakingClient: makeStakingClient(() => 0, counter1),
      port: port1,
    });
    const handle2 = createServer({
      poller,
      store: store2,
      stakingClient: makeStakingClient(() => 0, counter2),
      port: port2,
    });

    await handle1.start();
    await handle2.start();
    try {
      await fetch(`http://localhost:${port1}/stats`);
      await fetch(`http://localhost:${port2}/stats`);

      assert.equal(counter1.calls, 1);
      assert.equal(counter2.calls, 1);
    } finally {
      handle1.stop();
      handle2.stop();
      store1.close();
      store2.close();
    }
  });
});

// ── Test 8b: Duplicate addresses are resolved once ──────────────────────────────

describe('createServer — enriched: duplicate addresses are deduped per request', () => {
  const PORT = nextPort();
  const store = makeStore();
  const peers = [
    fakePeer('dup1', '0xduplicated'),
    fakePeer('dup2', '0xduplicated'),
  ];
  const poller = makePoller(peers);
  const counter = { calls: 0 };
  const stakingClient = makeStakingClient(() => 0, counter);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => {
    counter.calls = 0;
  });

  it('calls getAgentId once for peers sharing the same lookup address', async () => {
    await fetch(`http://localhost:${PORT}/stats`);

    assert.equal(counter.calls, 1);
  });
});

// ── Test 9: Staking RPC failure — no cache, recovers on retry ────────────────

describe('createServer — enriched: RPC failure does not cache', () => {
  const PORT = nextPort();
  const store = makeStore();
  const peers = [fakePeer('f', '0xfailing')];
  const poller = makePoller(peers);
  const counter = { calls: 0 };
  let shouldFail = true;
  const stakingClient = makeStakingClient((_addr: string) => {
    counter.calls++;
    if (shouldFail) throw new Error('RPC unavailable');
    return 0;
  });
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => {
    counter.calls = 0;
    shouldFail = true;
  });

  it('failure returns onChainStats: null and does not cache, recovery on next request', async () => {
    // First request: throws → null
    const res1 = await fetch(`http://localhost:${PORT}/stats`);
    const body1 = await res1.json() as { peers: Array<{ onChainStats: unknown }> };
    assert.equal(body1.peers[0]!.onChainStats, null, 'should be null on RPC failure');
    assert.equal(counter.calls, 1, 'should have called getAgentId once');

    // Simulate recovery
    shouldFail = false;

    // Second request: should retry (not cached) — returns 0 (unstaked)
    const res2 = await fetch(`http://localhost:${PORT}/stats`);
    const body2 = await res2.json() as { peers: Array<{ onChainStats: unknown }> };
    // agentId=0 → onChainStats: null (unstaked)
    assert.equal(body2.peers[0]!.onChainStats, null, 'unstaked peer should still return null');
    assert.equal(counter.calls, 2, 'second request must re-call getAgentId (failure was not cached)');
  });
});

// ── Test 10: BigInt round-trip ────────────────────────────────────────────────

describe('createServer — enriched: BigInt round-trip for large numbers', () => {
  const PORT = nextPort();
  const store = makeStore();
  const bigValue = 10n ** 25n;
  // Seed the store with bigint values for agentId 99
  store.applyBatch('test', '0xbig', [
    makeEvent({ agentId: 99n, blockNumber: 42, inputTokens: bigValue, outputTokens: bigValue * 2n, requestCount: bigValue * 3n }),
  ], 1);
  const peers = [fakePeer('g', '0xbigpeer')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 99);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  it('large bigint values survive JSON serialization as strings', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as { peers: Array<{ onChainStats: { totalRequests: string; totalInputTokens: string; totalOutputTokens: string } | null }> };
    const stats = body.peers[0]!.onChainStats;
    assert.ok(stats !== null, 'onChainStats should not be null');
    assert.equal(stats!.totalRequests, (bigValue * 3n).toString());
    assert.equal(stats!.totalInputTokens, bigValue.toString());
    assert.equal(stats!.totalOutputTokens, (bigValue * 2n).toString());
  });
});

// ── Test 11: Network metrics — legacy fast path ───────────────────────────────

// fakePeer() sets version='v1' (string) which the aggregator skips. These
// tests need real-shaped values to exercise the aggregate logic, so they
// override the noisy fields directly on the fixture.
type AggPeer = Record<string, unknown>;
function aggregatePeer(address: string, overrides: Partial<AggPeer>): AggPeer {
  return { ...fakePeer('agg', address), ...overrides };
}

describe('createServer — network metrics: legacy fast path', () => {
  const PORT = nextPort();
  const peers = [
    aggregatePeer('0xaaa', {}),
    aggregatePeer('0xbbb', {}),
    aggregatePeer('0xccc', {}),
  ];
  const poller = makePoller(peers);
  const handle = createServer({ poller, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); });

  it('GET /stats returns a network block alongside peers/updatedAt', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      peers: unknown[];
      updatedAt: string;
      network: {
        peerCount: number;
        serviceCounts: Record<string, number>;
        serviceCategoryCounts: Record<string, number>;
        stake: unknown;
        freshness: { medianAgeSeconds: number } | null;
        peersWithSellerContract: number;
        peersWithDisplayName: number;
      };
    };
    assert.ok(body.network, 'network block must be present in legacy path');
    assert.equal(body.network.peerCount, 3);
    assert.deepEqual(body.network.serviceCounts, {});           // no providers in fixture
    assert.deepEqual(body.network.serviceCategoryCounts, {});
    assert.equal(body.network.stake, null);                     // no stake in fixture
    assert.equal(body.network.peersWithSellerContract, 0);
    assert.equal(body.network.peersWithDisplayName, 0);
    assert.ok(body.network.freshness, 'freshness present when peers carry timestamps');
  });
});

// ── Test 12: Network metrics — enriched path ──────────────────────────────────

describe('createServer — network metrics: enriched path', () => {
  const PORT = nextPort();
  const store = makeStore();
  const peers = [
    aggregatePeer('0xabc', {}),
    aggregatePeer('0xdef', {}),
  ];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 0); // both unstaked
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  it('enriched response includes network alongside peers and totals', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as {
      peers: unknown[];
      network: {
        peerCount: number;
      };
      totals: { sellerCount: number };
    };
    assert.ok(body.network, 'network block must be present in enriched path');
    assert.equal(body.network.peerCount, 2);
    assert.ok(body.totals, 'totals must still be present in enriched path');
  });
});

// ── Test 13: /history endpoint ────────────────────────────────────────────────

describe('createServer — GET /history', () => {
  const PORT = nextPort();
  const store = makeStore();
  // Seed a couple of samples a few hours apart so 1d bucketing has data.
  const nowSec = Math.floor(Date.now() / 1000);
  store.recordHistorySample({
    ts: nowSec - 3600 * 3,
    activePeers: 5,
    sellerCount: 2,
    totalRequests: 100n,
    totalInputTokens: 0n,
    totalOutputTokens: 0n,
    settlementCount: 10,
  });
  store.recordHistorySample({
    ts: nowSec - 60,
    activePeers: 8,
    sellerCount: 3,
    totalRequests: 150n,
    totalInputTokens: 0n,
    totalOutputTokens: 0n,
    settlementCount: 14,
  });

  const poller = makePoller([fakePeer('a', '0xabc')]);
  const stakingClient = makeStakingClient(() => 0);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });

  it('GET /history?range=1d returns hourly buckets with delta + last-gauge fields', async () => {
    const res = await fetch(`http://localhost:${PORT}/history?range=1d`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      range: string;
      bucketSeconds: number;
      points: Array<{ ts: number; activePeers: number; requests: number; settlements: number }>;
    };
    assert.equal(body.range, '1d');
    assert.equal(body.bucketSeconds, 3600);
    assert.ok(body.points.length >= 2, 'expected at least 2 points');
    const last = body.points[body.points.length - 1]!;
    assert.equal(last.activePeers, 8);
    // Last bucket's request delta uses the previous bucket's last cumulative
    // as baseline → 150 - 100 = 50.
    assert.equal(last.requests, 50);
    assert.equal(last.settlements, 4);
  });

  it('GET /history with no range defaults to 1d', async () => {
    const res = await fetch(`http://localhost:${PORT}/history`);
    assert.equal(res.status, 200);
    const body = await res.json() as { range: string };
    assert.equal(body.range, '1d');
  });

  it('GET /history?range=bogus returns 400', async () => {
    const res = await fetch(`http://localhost:${PORT}/history?range=bogus`);
    assert.equal(res.status, 400);
  });
});

// ── Test 14: /history with no store ───────────────────────────────────────────

describe('createServer — GET /history without store', () => {
  const PORT = nextPort();
  const poller = makePoller([fakePeer('a', undefined)]);
  const handle = createServer({ poller, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); });

  it('returns empty payload when no store is configured', async () => {
    const res = await fetch(`http://localhost:${PORT}/history`);
    assert.equal(res.status, 200);
    const body = await res.json() as { range: string; points: unknown[] };
    assert.equal(body.range, '1d');
    assert.deepEqual(body.points, []);
  });
});

// ── Test 15: /insights endpoint ───────────────────────────────────────────────

describe('createServer — GET /insights (enriched)', () => {
  const PORT = nextPort();
  const store = makeStore();
  // Seed a single seller's totals so the leaderboards have something to rank.
  store.applyBatch('test', '0xcontract', [
    makeEvent({ agentId: 7n, blockNumber: 100, inputTokens: 1000n, outputTokens: 2000n, requestCount: 50n }),
  ], 1);
  // Seed two history samples to drive a non-null 24h velocity window.
  const nowSec = Math.floor(Date.now() / 1000);
  store.recordHistorySample({
    ts: nowSec - 86400 - 60,
    activePeers: 1, sellerCount: 1,
    totalRequests: 10n, totalInputTokens: 100n, totalOutputTokens: 200n, settlementCount: 1,
  });
  store.recordHistorySample({
    ts: nowSec - 60,
    activePeers: 2, sellerCount: 1,
    totalRequests: 60n, totalInputTokens: 1100n, totalOutputTokens: 2200n, settlementCount: 5,
  });

  const peers = [fakePeer('a', '0xabc1234')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 7);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });

  it('returns leaderboards + pricing + concentration + velocity + activity', async () => {
    const res = await fetch(`http://localhost:${PORT}/insights`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      leaderboards: { mostActive: Array<{ agentId: number; metric: string }> };
      pricing: { byService: Record<string, unknown> };
      services: { topServices: unknown[]; topCategories: unknown[] };
      regions: unknown[];
      concentration: { sellerCount: number };
      velocity: { last24h: { requestsDelta: string } | null };
      activity: { peersOnline: number; totalSellersIndexed: number };
    };
    assert.ok(Array.isArray(body.leaderboards.mostActive));
    assert.equal(body.leaderboards.mostActive.length, 1);
    assert.equal(body.leaderboards.mostActive[0]!.agentId, 7);
    assert.equal(body.leaderboards.mostActive[0]!.metric, '50');
    assert.equal(body.activity.peersOnline, 1);
    assert.equal(body.activity.totalSellersIndexed, 1);
    assert.equal(body.concentration.sellerCount, 1);
    assert.ok(body.velocity.last24h !== null);
    assert.equal(body.velocity.last24h!.requestsDelta, '50');
  });
});

// ── Test 16: /insights without store returns DHT-only payload ─────────────────

describe('createServer — GET /insights without store', () => {
  const PORT = nextPort();
  const peers = [fakePeer('a', undefined)];
  const poller = makePoller(peers);
  const handle = createServer({ poller, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); });

  it('still returns the DHT-only sections', async () => {
    const res = await fetch(`http://localhost:${PORT}/insights`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      leaderboards: { mostActive: unknown[] };
      activity: { peersOnline: number; totalSellersIndexed: number };
      velocity: { last24h: unknown };
    };
    assert.deepEqual(body.leaderboards.mostActive, []);
    assert.equal(body.activity.peersOnline, 1);
    assert.equal(body.activity.totalSellersIndexed, 0);
    assert.equal(body.velocity.last24h, null);
  });
});
