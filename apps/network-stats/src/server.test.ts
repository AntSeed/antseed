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

import { createServer, __resetAgentIdCacheForTests } from './server.js';
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
  beforeEach(() => { __resetAgentIdCacheForTests(); });

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
  beforeEach(() => { __resetAgentIdCacheForTests(); });

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
    __resetAgentIdCacheForTests();
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
  beforeEach(() => { __resetAgentIdCacheForTests(); });

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
  beforeEach(() => { __resetAgentIdCacheForTests(); });

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
  beforeEach(() => { __resetAgentIdCacheForTests(); });

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
    __resetAgentIdCacheForTests();
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
    __resetAgentIdCacheForTests();
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
    __resetAgentIdCacheForTests();
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

// ── Test: rankings — mostUsed + topVolume across windows + all-time ─────────

describe('createServer — rankings: mostUsed and topVolume', () => {
  const PORT = nextPort();
  const store = makeStore();
  const nowSec = Math.floor(Date.now() / 1000);
  const recentTs = nowSec - 60 * 60;        // 1h ago — inside every window
  const weekishTs = nowSec - 3 * 86_400;     // 3d ago — outside 24h, inside 7d/30d
  const ancientTs = nowSec - 60 * 86_400;    // 60d ago — outside every window

  // Three agents with different activity profiles:
  //   1: high all-time (lots of historic), but quiet in last 24h
  //   2: moderate all-time, very active in last 24h (the 24h winner)
  //   3: small all-time, no recent activity (won't appear in windowed lists)
  store.applyBatch(
    'test',
    '0xcontract',
    [
      // agent 1 — old & big
      makeEvent({ agentId: 1n, blockNumber: 1, logIndex: 0, inputTokens: 10_000n, outputTokens: 20_000n, requestCount: 100n }),
      // agent 1 — also has a 3-day-old event (in 7d/30d, not 24h)
      makeEvent({ agentId: 1n, blockNumber: 2, logIndex: 0, inputTokens: 100n, outputTokens: 200n, requestCount: 5n }),
      // agent 2 — small history but a bursty 24h
      makeEvent({ agentId: 2n, blockNumber: 3, logIndex: 0, inputTokens: 5n, outputTokens: 5n, requestCount: 1n }),
      makeEvent({ agentId: 2n, blockNumber: 4, logIndex: 0, inputTokens: 9_999_999n, outputTokens: 1n, requestCount: 50n }),
      // agent 3 — small all-time, no recent
      makeEvent({ agentId: 3n, blockNumber: 5, logIndex: 0, inputTokens: 1n, outputTokens: 1n, requestCount: 1n }),
    ],
    5,
    new Map([
      [1, ancientTs],
      [2, weekishTs],
      [3, recentTs],
      [4, recentTs],
      [5, ancientTs],
    ]),
  );

  const peers = [fakePeer('a', '0xabc')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 0); // agent resolution unused by rankings
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => { __resetAgentIdCacheForTests(); });

  it('mostUsed sorts by request count, descending; topVolume sorts by tokens', async () => {
    type Entry = { agentId: number; requests: string; inputTokens: string; outputTokens: string; settlements: number };
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as {
      rankings: {
        mostUsed: { last24h: Entry[]; last7d: Entry[]; last30d: Entry[]; allTime: Entry[] };
        topVolume: { last24h: Entry[]; last7d: Entry[]; last30d: Entry[]; allTime: Entry[] };
      };
    };

    // last24h — only agent 2's events (blocks 3+4 at recentTs) qualify.
    // Block 5 / agent 3 was stamped 60d ago, so agent 3 is excluded.
    assert.deepEqual(
      body.rankings.mostUsed.last24h.map((e) => e.agentId),
      [2],
    );
    assert.equal(body.rankings.mostUsed.last24h[0]!.requests, '51'); // 1 + 50

    // last7d — agent 2 (51 in window) and agent 1 (block 2 = weekishTs/3d ago, 5 reqs).
    assert.deepEqual(
      body.rankings.mostUsed.last7d.map((e) => e.agentId),
      [2, 1],
    );
    assert.equal(body.rankings.mostUsed.last7d[0]!.requests, '51');
    assert.equal(body.rankings.mostUsed.last7d[1]!.requests, '5');

    // allTime — agent 1 has 105 requests, agent 2 has 51, agent 3 has 1.
    assert.deepEqual(
      body.rankings.mostUsed.allTime.map((e) => e.agentId),
      [1, 2, 3],
    );
    assert.equal(body.rankings.mostUsed.allTime[0]!.requests, '105');

    // topVolume.last24h — agent 2 (~10M tokens) ranks before agent 3 (2 tokens).
    assert.equal(body.rankings.topVolume.last24h[0]!.agentId, 2);
    // topVolume.allTime — agent 2's 24h burst makes it the volume leader.
    assert.equal(body.rankings.topVolume.allTime[0]!.agentId, 2);
  });
});

// ── Test: rankings — mostReach + risingStars ─────────────────────────────────

describe('createServer — rankings: mostReach and risingStars', () => {
  const PORT = nextPort();
  const store = makeStore();
  const nowSec = Math.floor(Date.now() / 1000);
  const longAgo = nowSec - 100 * 86_400;     // 100 days ago
  const recentTs = nowSec - 60 * 60;          // 1h ago

  // agent 10: many distinct buyers (high reach), low recent activity
  // agent 20: few buyers but recent burst (rising star candidate)
  // agent 30: under the lifetime floor → excluded from risingStars
  const buyer = (n: number) => '0x' + n.toString(16).padStart(40, '0');

  store.applyBatch(
    'test',
    '0xcontract',
    [
      // agent 10 — 4 distinct buyers, 100 lifetime, 1 in last 7d
      makeEvent({ agentId: 10n, blockNumber: 1, logIndex: 0, buyer: buyer(1), requestCount: 30n }),
      makeEvent({ agentId: 10n, blockNumber: 2, logIndex: 0, buyer: buyer(2), requestCount: 30n }),
      makeEvent({ agentId: 10n, blockNumber: 3, logIndex: 0, buyer: buyer(3), requestCount: 30n }),
      makeEvent({ agentId: 10n, blockNumber: 4, logIndex: 0, buyer: buyer(4), requestCount: 9n }),
      makeEvent({ agentId: 10n, blockNumber: 5, logIndex: 0, buyer: buyer(1), requestCount: 1n }),
      // agent 20 — 1 distinct buyer, 10 lifetime, 8 in last 7d
      makeEvent({ agentId: 20n, blockNumber: 6, logIndex: 0, buyer: buyer(9), requestCount: 2n }),
      makeEvent({ agentId: 20n, blockNumber: 7, logIndex: 0, buyer: buyer(9), requestCount: 8n }),
      // agent 30 — 1 buyer, 2 lifetime — below floor of 5
      makeEvent({ agentId: 30n, blockNumber: 8, logIndex: 0, buyer: buyer(99), requestCount: 2n }),
    ],
    8,
    new Map([
      [1, longAgo], [2, longAgo], [3, longAgo], [4, longAgo],
      [5, recentTs],
      [6, longAgo], [7, recentTs],
      [8, recentTs],
    ]),
  );

  const poller = makePoller([fakePeer('x', '0xabc')]);
  const stakingClient = makeStakingClient(() => 0);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => { __resetAgentIdCacheForTests(); });

  it('mostReach sorts by uniqueBuyers desc; risingStars filters and ranks by score', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as {
      rankings: {
        mostReach: Array<{ agentId: number; uniqueBuyers: number; totalRequests: string }>;
        risingStars: Array<{ agentId: number; score: number; requests7d: string; lifetimeRequests: string; daysActive: number }>;
      };
    };

    // mostReach: agent 10 (4 buyers) > agent 20 (1 buyer) = agent 30 (1 buyer)
    assert.equal(body.rankings.mostReach[0]!.agentId, 10);
    assert.equal(body.rankings.mostReach[0]!.uniqueBuyers, 4);

    // risingStars: agent 30 excluded (lifetime < 5).
    // agent 10: requests7d=1, lifetime=100, daysActive≈100 → rate≈1/day → score≈1
    // agent 20: requests7d=8, lifetime=10,  daysActive≈100 → rate≈0.1/day → score≈80
    // → agent 20 ranks first; agent 30 is absent.
    const ids = body.rankings.risingStars.map((s) => s.agentId);
    assert.ok(!ids.includes(30), 'agent 30 below lifetime floor must be excluded');
    assert.equal(ids[0], 20);
    assert.ok(body.rankings.risingStars[0]!.score > body.rankings.risingStars[1]!.score);
  });
});

// ── Test: rankings — empty when no events recorded with timestamps ───────────

describe('createServer — rankings: empty windowed lists when no event rows', () => {
  const PORT = nextPort();
  const store = makeStore();
  // applyBatch WITHOUT timestamps → all-time totals exist but events table is empty
  store.applyBatch('test', '0xcontract', [
    makeEvent({ agentId: 42n, blockNumber: 1, inputTokens: 100n, outputTokens: 200n, requestCount: 5n }),
  ], 1);
  const poller = makePoller([fakePeer('a', '0xabc')]);
  const stakingClient = makeStakingClient(() => 0);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => { __resetAgentIdCacheForTests(); });

  it('windowed rankings empty, allTime still populated, risingStars empty (no firstSeenAt)', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as {
      rankings: {
        mostUsed: { last24h: unknown[]; last7d: unknown[]; last30d: unknown[]; allTime: Array<{ agentId: number; requests: string }> };
        topVolume: { last24h: unknown[]; allTime: unknown[] };
        risingStars: unknown[];
      };
    };
    assert.equal(body.rankings.mostUsed.last24h.length, 0);
    assert.equal(body.rankings.mostUsed.last7d.length, 0);
    assert.equal(body.rankings.mostUsed.last30d.length, 0);
    assert.equal(body.rankings.mostUsed.allTime.length, 1);
    assert.equal(body.rankings.mostUsed.allTime[0]!.agentId, 42);
    assert.equal(body.rankings.mostUsed.allTime[0]!.requests, '5');
    assert.equal(body.rankings.risingStars.length, 0);
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
  beforeEach(() => { __resetAgentIdCacheForTests(); });

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

