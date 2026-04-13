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
import type { StakingClient } from '@antseed/node';

// ── helpers ───────────────────────────────────────────────────────────────────

function fakePeer(id: string, publicAddress: string | undefined) {
  const peer: Record<string, unknown> = {
    peerId: 'peer-' + id,
    publicAddress,
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
    { agentId: 42n, inputTokens: 100n, outputTokens: 200n, requestCount: 5n } as never,
  ], 1);
  const peers = [fakePeer('a', '0xabc1234')];
  const poller = makePoller(peers);
  const stakingClient = makeStakingClient(() => 42);
  const handle = createServer({ poller, store, stakingClient, port: PORT });

  before(async () => { await handle.start(); });
  after(() => { handle.stop(); store.close(); });
  beforeEach(() => { __resetAgentIdCacheForTests(); });

  it('peer has onChainStats with correct values', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    const body = await res.json() as { peers: Array<{ onChainStats: { agentId: number; totalRequests: string; totalInputTokens: string; totalOutputTokens: string; lastUpdatedAt: number } | null }> };
    assert.equal(body.peers.length, 1);
    const stats = body.peers[0]!.onChainStats;
    assert.ok(stats !== null, 'onChainStats should not be null');
    assert.equal(stats!.agentId, 42);
    assert.equal(stats!.totalRequests, '5');
    assert.equal(stats!.totalInputTokens, '100');
    assert.equal(stats!.totalOutputTokens, '200');
    assert.equal(typeof stats!.lastUpdatedAt, 'number');
  });
});

// ── Test 3: Enriched — agent with no events ───────────────────────────────────

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

// ── Test 4: Enriched — unstaked peer (agentId = 0) ────────────────────────────

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

// ── Test 5: Enriched — missing publicAddress ─────────────────────────────────

describe('createServer — enriched: peer missing publicAddress', () => {
  const PORT = nextPort();
  const store = makeStore();
  const peers = [fakePeer('d', undefined)]; // no publicAddress
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
    assert.equal(counter.calls, 0, 'getAgentId must not be called when publicAddress is missing');
  });
});

// ── Test 6: Cache is reused ───────────────────────────────────────────────────

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

// ── Test 7: Staking RPC failure — no cache, recovers on retry ────────────────

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

// ── Test 8: BigInt round-trip ─────────────────────────────────────────────────

describe('createServer — enriched: BigInt round-trip for large numbers', () => {
  const PORT = nextPort();
  const store = makeStore();
  const bigValue = 10n ** 25n;
  // Seed the store with bigint values for agentId 99
  store.applyBatch('test', '0xbig', [
    { agentId: 99n, inputTokens: bigValue, outputTokens: bigValue * 2n, requestCount: bigValue * 3n } as never,
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
