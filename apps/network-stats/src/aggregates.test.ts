/**
 * Unit tests for computeNetworkAggregates.
 *
 * Uses node:test (built-in). Pure function — no fixtures, no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeNetworkAggregates } from './aggregates.js';
import type { PeerMetadata } from '@antseed/node';

// Minimal helper. PeerMetadata has many optional fields; tests fill only
// what they need and let the rest stay undefined. The cast goes through
// `unknown` because we deliberately omit fields the type marks required
// (signature, timestamp, etc.) when the test doesn't exercise them.
function peer(overrides: Partial<PeerMetadata>): PeerMetadata {
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

describe('computeNetworkAggregates — empty input', () => {
  it('returns zero counts and null distributions', () => {
    const a = computeNetworkAggregates([]);
    assert.equal(a.peerCount, 0);
    assert.deepEqual(a.serviceCounts, {});
    assert.deepEqual(a.serviceCategoryCounts, {});
    assert.equal(a.stake, null);
    assert.equal(a.freshness, null);
    assert.equal(a.peersWithSellerContract, 0);
    assert.equal(a.peersWithDisplayName, 0);
  });
});

describe('computeNetworkAggregates — service mix dedup', () => {
  it('counts a peer once per service even if it appears in multiple providers', () => {
    const a = computeNetworkAggregates([
      peer({
        providers: [
          { provider: 'p1', services: ['anthropic', 'openai'], defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, maxConcurrency: 1, currentLoad: 0 },
          { provider: 'p2', services: ['anthropic'], defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, maxConcurrency: 1, currentLoad: 0 },
        ],
      }),
      peer({
        providers: [
          { provider: 'p3', services: ['openai'], defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, maxConcurrency: 1, currentLoad: 0 },
        ],
      }),
    ]);
    assert.deepEqual(a.serviceCounts, { anthropic: 1, openai: 2 });
  });
});

describe('computeNetworkAggregates — service category mix', () => {
  it('counts peers per category, deduped across providers', () => {
    const a = computeNetworkAggregates([
      peer({
        providers: [
          {
            provider: 'p1',
            services: ['anthropic'],
            defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
            maxConcurrency: 1,
            currentLoad: 0,
            serviceCategories: { anthropic: ['coding', 'tee'] },
          },
          {
            provider: 'p2',
            services: ['openai'],
            defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
            maxConcurrency: 1,
            currentLoad: 0,
            serviceCategories: { openai: ['coding'] }, // duplicate "coding" → still counts once for this peer
          },
        ],
      }),
      peer({
        providers: [
          {
            provider: 'p3',
            services: ['local'],
            defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
            maxConcurrency: 1,
            currentLoad: 0,
            serviceCategories: { local: ['privacy'] },
          },
        ],
      }),
    ]);
    assert.deepEqual(a.serviceCategoryCounts, { coding: 1, tee: 1, privacy: 1 });
  });
});

describe('computeNetworkAggregates — stake distribution', () => {
  it('returns null when no peer reports stake', () => {
    const a = computeNetworkAggregates([peer({}), peer({})]);
    assert.equal(a.stake, null);
  });

  it('aggregates only peers with stakeAmountUSDC > 0', () => {
    const a = computeNetworkAggregates([
      peer({ stakeAmountUSDC: 100 }),
      peer({ stakeAmountUSDC: 200 }),
      peer({ stakeAmountUSDC: 300 }),
      peer({ stakeAmountUSDC: 0 }),     // ignored
      peer({}),                          // ignored — no stake field
    ]);
    assert.ok(a.stake !== null);
    assert.equal(a.stake!.peersWithStake, 3);
    assert.equal(a.stake!.totalUsdc, 600);
    assert.equal(a.stake!.medianUsdc, 200);
    assert.equal(a.stake!.p95Usdc, 300);
  });
});

describe('computeNetworkAggregates — freshness', () => {
  it('returns null when no peer has a usable timestamp', () => {
    const a = computeNetworkAggregates([peer({ timestamp: 0 })]);
    assert.equal(a.freshness, null);
  });

  it('computes ages relative to nowMs', () => {
    const now = 2_000_000_000_000;
    const a = computeNetworkAggregates(
      [
        peer({ timestamp: now - 60_000 }),       // 60 s old
        peer({ timestamp: now - 120_000 }),      // 120 s old
        peer({ timestamp: now - 600_000 }),      // 600 s old (oldest)
      ],
      now,
    );
    assert.ok(a.freshness !== null);
    assert.equal(a.freshness!.newestAgeSeconds, 60);
    assert.equal(a.freshness!.oldestAgeSeconds, 600);
    assert.equal(a.freshness!.medianAgeSeconds, 120);
    assert.equal(a.freshness!.p95AgeSeconds, 600);
  });

  it('clamps negative ages (peer timestamp ahead of nowMs) to 0', () => {
    const now = 1_000_000_000_000;
    const a = computeNetworkAggregates(
      [peer({ timestamp: now + 5_000 })],
      now,
    );
    assert.ok(a.freshness !== null);
    assert.equal(a.freshness!.newestAgeSeconds, 0);
  });
});

describe('computeNetworkAggregates — sellerContract and displayName counts', () => {
  it('counts only peers where the field is present and non-empty', () => {
    const a = computeNetworkAggregates([
      peer({ sellerContract: 'aa', displayName: 'Alice' }),
      peer({ sellerContract: 'bb' }),
      peer({ displayName: 'Bob' }),
      peer({}),
    ]);
    assert.equal(a.peersWithSellerContract, 2);
    assert.equal(a.peersWithDisplayName, 2);
  });
});

describe('computeNetworkAggregates — does not mutate input', () => {
  it('input array and stake values are unchanged after compute', () => {
    const peers = [peer({ stakeAmountUSDC: 50 }), peer({ stakeAmountUSDC: 10 }), peer({ stakeAmountUSDC: 30 })];
    const snapshotBefore = JSON.stringify(peers);
    computeNetworkAggregates(peers);
    assert.equal(JSON.stringify(peers), snapshotBefore);
  });
});
