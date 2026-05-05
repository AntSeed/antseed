/**
 * Unit tests for computeInsights — pure derivations, no I/O.
 *
 * Style mirrors metrics.test.ts: small fixture builders, one focused
 * `describe` per derivation, node:test built-in runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeInsights } from './insights.js';
import type { ComputeInsightsInput } from './insights.js';
import type { PeerMetadata } from '@antseed/node';
import type {
  HistorySample,
  PriceVolatilityRow,
  SellerActivityRow,
  SellerTotalsWithId,
} from './store.js';

function peer(overrides: Partial<PeerMetadata> & { peerId?: string }): PeerMetadata {
  return {
    peerId: 'aa' as never,
    version: 8,
    providers: [],
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'sig',
    ...overrides,
  } as PeerMetadata;
}

function seller(overrides: Partial<SellerTotalsWithId>): SellerTotalsWithId {
  return {
    agentId: 1,
    totalRequests: 0n,
    totalInputTokens: 0n,
    totalOutputTokens: 0n,
    settlementCount: 0,
    firstSettledBlock: 0,
    lastSettledBlock: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    uniqueBuyers: 0,
    uniqueChannels: 0,
    avgRequestsPerBuyer: 0,
    avgRequestsPerChannel: 0,
    lastUpdatedAt: 0,
    ...overrides,
  };
}

function sample(overrides: Partial<HistorySample>): HistorySample {
  return {
    ts: 0,
    activePeers: 0,
    sellerCount: 0,
    totalRequests: 0n,
    totalInputTokens: 0n,
    totalOutputTokens: 0n,
    settlementCount: 0,
    ...overrides,
  };
}

function input(overrides: Partial<ComputeInsightsInput> = {}): ComputeInsightsInput {
  return {
    peers: [],
    sellerTotals: [],
    agentIdByPeerAddress: new Map(),
    history: [],
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

// ── empty input ────────────────────────────────────────────────────────────

describe('computeInsights — empty input', () => {
  it('returns null/empty values without throwing', () => {
    const out = computeInsights(input());
    assert.equal(out.leaderboards.mostActive.length, 0);
    assert.deepEqual(out.pricing.byService, {});
    assert.deepEqual(out.services.topServices, []);
    assert.deepEqual(out.regions, []);
    assert.equal(out.concentration.gini, null);
    assert.equal(out.concentration.herfindahl, null);
    assert.equal(out.concentration.top10Share, null);
    assert.equal(out.velocity.last24h, null);
    assert.equal(out.velocity.last7d, null);
    assert.equal(out.activity.peersOnline, 0);
    assert.equal(out.activity.totalSellersIndexed, 0);
  });
});

// ── leaderboards ───────────────────────────────────────────────────────────

describe('leaderboards.mostActive', () => {
  it('ranks sellers by totalRequests desc and ties matching peers', () => {
    const out = computeInsights(input({
      sellerTotals: [
        seller({ agentId: 10, totalRequests: 100n, settlementCount: 5 }),
        seller({ agentId: 11, totalRequests: 500n, settlementCount: 7 }),
        seller({ agentId: 12, totalRequests: 0n }),  // filtered (no activity)
        seller({ agentId: 13, totalRequests: 250n, settlementCount: 3 }),
      ],
      peers: [
        peer({ peerId: 'aaaa' as never, displayName: 'Top', sellerContract: '0xabc' }),
      ],
      agentIdByPeerAddress: new Map([['0xabc', 11]]),
    }));
    const board = out.leaderboards.mostActive;
    assert.equal(board.length, 3);
    assert.equal(board[0]!.agentId, 11);
    assert.equal(board[0]!.metric, '500');
    assert.equal(board[0]!.peerId, 'aaaa');
    assert.equal(board[0]!.displayName, 'Top');
    assert.equal(board[1]!.agentId, 13);
    assert.equal(board[2]!.agentId, 10);
    // sellers without a matching live peer come back with null peer fields
    assert.equal(board[1]!.peerId, null);
    assert.equal(board[1]!.displayName, null);
  });
});

describe('leaderboards.mostStaked / mostDiverse', () => {
  it('ranks DHT-only metrics and excludes peers with no signal', () => {
    const p1 = peer({
      peerId: 'p1' as never,
      stakeAmountUSDC: 1000,
      providers: [{
        provider: 'a', services: ['anthropic', 'openai'],
        defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        serviceCategories: { anthropic: ['coding', 'tee'] },
        maxConcurrency: 1, currentLoad: 0,
      }],
    });
    const p2 = peer({ peerId: 'p2' as never, stakeAmountUSDC: 5000, providers: [] });
    const p3 = peer({ peerId: 'p3' as never });  // no stake, no providers — excluded from both
    const out = computeInsights(input({ peers: [p1, p2, p3] }));
    assert.equal(out.leaderboards.mostStaked.length, 2);
    assert.equal(out.leaderboards.mostStaked[0]!.peerId, 'p2');
    assert.equal(out.leaderboards.mostStaked[0]!.metric, '5000');
    assert.equal(out.leaderboards.mostDiverse.length, 1);
    assert.equal(out.leaderboards.mostDiverse[0]!.peerId, 'p1');
    // 2 services + 2 categories = 4
    assert.equal(out.leaderboards.mostDiverse[0]!.metric, '4');
    assert.equal(out.leaderboards.mostDiverse[0]!.secondary, 2);
  });
});

describe('leaderboards.newest / oldest', () => {
  it('sorts by firstSeenAt and ignores rows without a timestamp', () => {
    const out = computeInsights(input({
      sellerTotals: [
        seller({ agentId: 1, firstSeenAt: 100 }),
        seller({ agentId: 2, firstSeenAt: 200 }),
        seller({ agentId: 3, firstSeenAt: null }),
        seller({ agentId: 4, firstSeenAt: 50 }),
      ],
    }));
    assert.equal(out.leaderboards.newest[0]!.agentId, 2);
    assert.equal(out.leaderboards.newest[0]!.metric, '200');
    assert.equal(out.leaderboards.oldest[0]!.agentId, 4);
    assert.equal(out.leaderboards.oldest[0]!.metric, '50');
    assert.equal(out.leaderboards.newest.length, 3);
    assert.equal(out.leaderboards.oldest.length, 3);
  });
});

// ── pricing market ─────────────────────────────────────────────────────────

describe('pricing.byService', () => {
  it('uses servicePricing when present and falls back to defaultPricing', () => {
    const out = computeInsights(input({
      peers: [
        peer({
          peerId: 'p1' as never,
          providers: [{
            provider: 'a',
            services: ['anthropic', 'openai'],
            defaultPricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 10 },
            servicePricing: { anthropic: { inputUsdPerMillion: 3, outputUsdPerMillion: 9 } },
            maxConcurrency: 1, currentLoad: 0,
          }],
        }),
        peer({
          peerId: 'p2' as never,
          providers: [{
            provider: 'b',
            services: ['anthropic'],
            defaultPricing: { inputUsdPerMillion: 7, outputUsdPerMillion: 14 },
            maxConcurrency: 1, currentLoad: 0,
          }],
        }),
      ],
    }));
    const anthropic = out.pricing.byService['anthropic']!;
    assert.equal(anthropic.peerCount, 2);
    assert.equal(anthropic.input.min, 3);
    assert.equal(anthropic.input.max, 7);
    // p1 announced 3 (specific) which beats p2's 7 (default), so cheapest = p1
    assert.equal(anthropic.cheapestPeerId, 'p1');
    assert.equal(anthropic.cheapestInputUsdPerMillion, 3);

    const openai = out.pricing.byService['openai']!;
    assert.equal(openai.peerCount, 1);
    // openai falls back to p1's defaultPricing → 5
    assert.equal(openai.input.min, 5);
  });

  it('de-dups when one peer offers the same service through multiple providers, keeping the cheapest input', () => {
    const out = computeInsights(input({
      peers: [
        peer({
          peerId: 'p1' as never,
          providers: [
            { provider: 'a', services: ['x'], defaultPricing: { inputUsdPerMillion: 9, outputUsdPerMillion: 9 }, maxConcurrency: 1, currentLoad: 0 },
            { provider: 'b', services: ['x'], defaultPricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 }, maxConcurrency: 1, currentLoad: 0 },
          ],
        }),
      ],
    }));
    const x = out.pricing.byService['x']!;
    assert.equal(x.peerCount, 1);
    assert.equal(x.input.min, 2);
    assert.equal(x.cheapestInputUsdPerMillion, 2);
  });
});

// ── service rankings ───────────────────────────────────────────────────────

describe('services rankings', () => {
  it('counts each peer once per service/category/protocol/provider', () => {
    const out = computeInsights(input({
      peers: [
        peer({
          providers: [{
            provider: 'p1', services: ['anthropic', 'openai'],
            defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
            serviceCategories: { anthropic: ['coding'] },
            serviceApiProtocols: { anthropic: ['anthropic-messages'], openai: ['openai-chat-completions'] },
            maxConcurrency: 1, currentLoad: 0,
          }],
        }),
        peer({
          providers: [{
            provider: 'p1', services: ['anthropic'],
            defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
            maxConcurrency: 1, currentLoad: 0,
          }],
        }),
      ],
    }));
    assert.deepEqual(out.services.topServices, [
      { key: 'anthropic', peers: 2 },
      { key: 'openai', peers: 1 },
    ]);
    assert.deepEqual(out.services.topProviders, [{ key: 'p1', peers: 2 }]);
    assert.deepEqual(out.services.topCategories, [{ key: 'coding', peers: 1 }]);
    assert.equal(out.services.topProtocols.length, 2);
  });
});

// ── regions ────────────────────────────────────────────────────────────────

describe('regions', () => {
  it('counts peers per region and sorts desc', () => {
    const out = computeInsights(input({
      peers: [
        peer({ region: 'us-east-1' }),
        peer({ region: 'us-east-1' }),
        peer({ region: 'eu-west-1' }),
      ],
    }));
    assert.deepEqual(out.regions, [
      { region: 'us-east-1', peers: 2 },
      { region: 'eu-west-1', peers: 1 },
    ]);
  });
});

// ── concentration ──────────────────────────────────────────────────────────

describe('concentration', () => {
  it('reports null/0 for trivial inputs', () => {
    // single seller with non-zero requests → gini is undefined for n<2
    const out1 = computeInsights(input({
      sellerTotals: [seller({ agentId: 1, totalRequests: 100n })],
    }));
    assert.equal(out1.concentration.sellerCount, 1);
    assert.equal(out1.concentration.gini, null);

    // perfectly equal → gini ~ 0
    const out2 = computeInsights(input({
      sellerTotals: [
        seller({ agentId: 1, totalRequests: 100n }),
        seller({ agentId: 2, totalRequests: 100n }),
        seller({ agentId: 3, totalRequests: 100n }),
      ],
    }));
    assert.ok(Math.abs(out2.concentration.gini ?? 1) < 1e-9, `expected gini~0, got ${out2.concentration.gini}`);
    // HHI for 3 equal sellers = 3 * (1/3)^2 = 1/3
    assert.ok(Math.abs((out2.concentration.herfindahl ?? 0) - 1/3) < 1e-9);
  });

  it('reports a high gini for a near-monopoly', () => {
    const out = computeInsights(input({
      sellerTotals: [
        seller({ agentId: 1, totalRequests: 1n }),
        seller({ agentId: 2, totalRequests: 1n }),
        seller({ agentId: 3, totalRequests: 998n }),
      ],
    }));
    assert.ok((out.concentration.gini ?? 0) > 0.6, `expected gini > 0.6, got ${out.concentration.gini}`);
    // top10Share captures everyone here (only 3 sellers), so 1.0
    assert.equal(out.concentration.top10Share, 1);
  });
});

// ── velocity ───────────────────────────────────────────────────────────────

describe('velocity', () => {
  it('computes 24h delta and growth vs prior 24h', () => {
    const t0 = 1_700_000_000;  // unix sec
    // Three samples, 24h apart: 0 → 100 → 250 → 600 cumulative requests.
    // The "now" sample is at t0 + 2d. last 24h delta = 600-250 = 350,
    // prior 24h delta = 250-100 = 150 → growth = (350-150)/150 ≈ 1.333.
    const out = computeInsights(input({
      history: [
        sample({ ts: t0,            totalRequests: 100n }),
        sample({ ts: t0 + 86400,    totalRequests: 250n }),
        sample({ ts: t0 + 86400 * 2, totalRequests: 600n }),
      ],
      nowMs: (t0 + 86400 * 2) * 1000,
    }));
    assert.ok(out.velocity.last24h !== null);
    assert.equal(out.velocity.last24h!.requestsDelta, '350');
    assert.ok(Math.abs((out.velocity.last24h!.requestsGrowthPct ?? 0) - 200/150) < 1e-9);
  });

  it('returns null when history is too short', () => {
    const out = computeInsights(input({
      history: [sample({ ts: 1, totalRequests: 5n })],
      nowMs: 86_400_000,
    }));
    assert.equal(out.velocity.last24h, null);
  });
});

// ── activity ───────────────────────────────────────────────────────────────

describe('activity', () => {
  it('counts sellers with lastSeenAt within 24h as active', () => {
    const nowSec = 1_700_000_000;
    const out = computeInsights(input({
      peers: [peer({}), peer({})],
      sellerTotals: [
        seller({ agentId: 1, lastSeenAt: nowSec - 100 }),       // active
        seller({ agentId: 2, lastSeenAt: nowSec - 86400 - 100 }),  // stale
        seller({ agentId: 3, lastSeenAt: null }),                  // never seen
      ],
      nowMs: nowSec * 1000,
    }));
    assert.equal(out.activity.peersOnline, 2);
    assert.equal(out.activity.sellersActiveLast24h, 1);
    assert.equal(out.activity.totalSellersIndexed, 3);
  });
});

// ── price stability + movers ───────────────────────────────────────────────

function volatility(overrides: Partial<PriceVolatilityRow>): PriceVolatilityRow {
  return {
    peerId: 'aa',
    provider: 'p',
    service: 's',
    sampleCount: 1,
    changeCount: 1,
    firstTs: 0,
    lastTs: 0,
    firstInputUsdPerMillion: 1,
    firstOutputUsdPerMillion: 2,
    latestInputUsdPerMillion: 1,
    latestOutputUsdPerMillion: 2,
    ...overrides,
  };
}

describe('priceStability', () => {
  it('ranks lowest changeCount as most stable, attaches displayName from snapshot', () => {
    const out = computeInsights(input({
      peers: [peer({ peerId: 'aa' as never, displayName: 'Alpha' })],
      priceVolatility: [
        volatility({ peerId: 'aa', service: 's1', changeCount: 1, sampleCount: 100 }),
        volatility({ peerId: 'bb', service: 's2', changeCount: 5, sampleCount: 50 }),
        volatility({ peerId: 'cc', service: 's3', changeCount: 10, sampleCount: 30 }),
      ],
    }));
    assert.equal(out.priceStability.mostStable.length, 3);
    assert.equal(out.priceStability.mostStable[0]!.peerId, 'aa');
    assert.equal(out.priceStability.mostStable[0]!.displayName, 'Alpha');
    assert.equal(out.priceStability.mostStable[0]!.changeCount, 1);
    assert.equal(out.priceStability.mostVolatile.length, 2);
    assert.equal(out.priceStability.mostVolatile[0]!.peerId, 'cc');
    assert.equal(out.priceStability.mostVolatile[0]!.changeCount, 10);
  });

  it('mostVolatile excludes rows with changeCount < 2', () => {
    const out = computeInsights(input({
      priceVolatility: [
        volatility({ peerId: 'aa', changeCount: 1 }),
        volatility({ peerId: 'bb', changeCount: 1 }),
      ],
    }));
    assert.equal(out.priceStability.mostVolatile.length, 0);
    assert.equal(out.priceStability.mostStable.length, 2);
  });
});

describe('priceMovers', () => {
  it('computes signed % change and splits into drops vs hikes, ignoring tiny moves', () => {
    const out = computeInsights(input({
      priceVolatility: [
        // 10% drop
        volatility({ peerId: 'aa', firstInputUsdPerMillion: 10, latestInputUsdPerMillion: 9 }),
        // 50% hike
        volatility({ peerId: 'bb', firstInputUsdPerMillion: 2, latestInputUsdPerMillion: 3 }),
        // 0.5% move — under PRICE_MOVER_MIN_PCT, filtered out
        volatility({ peerId: 'cc', firstInputUsdPerMillion: 100, latestInputUsdPerMillion: 100.5 }),
        // unchanged — filtered out
        volatility({ peerId: 'dd', firstInputUsdPerMillion: 5, latestInputUsdPerMillion: 5 }),
      ],
    }));
    assert.equal(out.priceMovers.biggestDrops.length, 1);
    assert.equal(out.priceMovers.biggestDrops[0]!.peerId, 'aa');
    assert.ok(out.priceMovers.biggestDrops[0]!.inputChangePct < -0.09);
    assert.equal(out.priceMovers.biggestHikes.length, 1);
    assert.equal(out.priceMovers.biggestHikes[0]!.peerId, 'bb');
    assert.ok(out.priceMovers.biggestHikes[0]!.inputChangePct > 0.49);
  });
});

// ── trending leaderboards ──────────────────────────────────────────────────

function activity(overrides: Partial<SellerActivityRow>): SellerActivityRow {
  return {
    agentId: 1,
    ts: 0,
    totalRequests: 0n,
    totalInputTokens: 0n,
    totalOutputTokens: 0n,
    settlementCount: 0,
    ...overrides,
  };
}

describe('leaderboards.trendingUp / trendingDown', () => {
  it('ranks sellers whose last 24h exceeds prior 7d daily average', () => {
    const t0 = 1_700_000_000;
    // Three sellers, all sampled at -8d, -1d, and now.
    // - agent 1: 0 → 7 → 100 (24h delta=93, prior 7d=7, avg/day=1, ratio=93)
    // - agent 2: 0 → 100 → 110 (24h delta=10, prior 7d=100, avg/day≈14.3, ratio≈0.7) → trendingDown
    // - agent 3: 0 → 0 → 50 (prior 7d=0 → "new" sentinel via Infinity ratio)
    const out = computeInsights(input({
      sellerTotals: [
        seller({ agentId: 1, totalRequests: 100n }),
        seller({ agentId: 2, totalRequests: 110n }),
        seller({ agentId: 3, totalRequests: 50n }),
      ],
      sellerActivity: [
        activity({ agentId: 1, ts: t0 - 86400 * 8, totalRequests: 0n }),
        activity({ agentId: 1, ts: t0 - 86400,     totalRequests: 7n }),
        activity({ agentId: 1, ts: t0,             totalRequests: 100n }),
        activity({ agentId: 2, ts: t0 - 86400 * 8, totalRequests: 0n }),
        activity({ agentId: 2, ts: t0 - 86400,     totalRequests: 100n }),
        activity({ agentId: 2, ts: t0,             totalRequests: 110n }),
        activity({ agentId: 3, ts: t0 - 86400 * 8, totalRequests: 0n }),
        activity({ agentId: 3, ts: t0 - 86400,     totalRequests: 0n }),
        activity({ agentId: 3, ts: t0,             totalRequests: 50n }),
      ],
      nowMs: t0 * 1000,
    }));

    // agent 3 has Infinity ratio (brand-new) so it should rank first; agent 1
    // is finite-but-high; agent 2 is on the trending-down board.
    assert.equal(out.leaderboards.trendingUp.length, 2);
    assert.equal(out.leaderboards.trendingUp[0]!.agentId, 3);
    assert.equal(out.leaderboards.trendingUp[0]!.metric, 'new');
    assert.equal(out.leaderboards.trendingUp[1]!.agentId, 1);
    assert.equal(out.leaderboards.trendingDown.length, 1);
    assert.equal(out.leaderboards.trendingDown[0]!.agentId, 2);
    assert.ok(parseFloat(out.leaderboards.trendingDown[0]!.metric) < 1);
  });

  it('ignores sellers below the volume threshold', () => {
    const t0 = 1_700_000_000;
    // Tiny absolute volumes — must not create a "trending up 100×" row.
    const out = computeInsights(input({
      sellerTotals: [seller({ agentId: 1, totalRequests: 2n })],
      sellerActivity: [
        activity({ agentId: 1, ts: t0 - 86400 * 8, totalRequests: 0n }),
        activity({ agentId: 1, ts: t0 - 86400,     totalRequests: 1n }),
        activity({ agentId: 1, ts: t0,             totalRequests: 2n }),
      ],
      nowMs: t0 * 1000,
    }));
    assert.equal(out.leaderboards.trendingUp.length, 0);
  });
});
