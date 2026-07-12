import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { DiscoverRow, VprRoutingPreferences } from '../core/state';
import { chooseBestVprRoute, scoreVprRoute } from './vpr-routing.js';

const preferences: VprRoutingPreferences = {
  autoRouting: true,
  preferFreePeers: false,
  maxInputUsdPerMillion: 10,
  minTrustScore: 50,
};

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const peerId = overrides.peerId ?? 'p1';
  const serviceId = overrides.serviceId ?? 's1';
  const provider = overrides.provider ?? 'openai';
  return {
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId,
    categories: [],
    provider,
    protocol: 'openai-chat-completions',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: '',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cachedInputUsdPerMillion: null,
    lifetimeSessions: 0,
    lifetimeRequests: 0,
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    lifetimeFirstSessionAt: null,
    lifetimeLastSessionAt: null,
    onChainChannelCount: null,
    agentId: 1,
    stakeUsdc: '0',
    onChainActiveChannelCount: 0,
    onChainGhostCount: 0,
    onChainTotalVolumeUsdc: '0',
    onChainLastSettledAt: 0,
    onChainReputationScore: null,
    onChainTrustScore: 75,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    selectionValue: `${provider}\u0001${serviceId}\u0001${peerId}`,
    ...overrides,
  };
}

test('free peer wins when preferFreePeers is true', () => {
  const best = chooseBestVprRoute(
    [
      discoverRow({ peerId: 'paid', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }),
      discoverRow({ peerId: 'free', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }),
    ],
    { ...preferences, preferFreePeers: true },
  );

  assert.equal(best?.peerId, 'free');
});

test('peer over max input price is penalized', () => {
  const cheap = discoverRow({ peerId: 'cheap', inputUsdPerMillion: 9, outputUsdPerMillion: 0 });
  const expensive = discoverRow({ peerId: 'expensive', inputUsdPerMillion: 11, outputUsdPerMillion: 0 });

  assert.equal(chooseBestVprRoute([expensive, cheap], preferences)?.peerId, 'cheap');
  assert.ok(scoreVprRoute(expensive, preferences).score < scoreVprRoute(cheap, preferences).score);
});

test('peer below min trust score is penalized', () => {
  const trusted = discoverRow({ peerId: 'trusted', onChainTrustScore: 50 });
  const lowTrust = discoverRow({ peerId: 'low-trust', onChainTrustScore: 49 });

  assert.equal(chooseBestVprRoute([lowTrust, trusted], preferences)?.peerId, 'trusted');
  assert.ok(scoreVprRoute(lowTrust, preferences).score < scoreVprRoute(trusted, preferences).score);
});

test('tie breaker uses lower price', () => {
  const cheaper = discoverRow({
    peerId: 'cheaper',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    onChainTrustScore: 60,
  });
  const pricier = discoverRow({
    peerId: 'pricier',
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 3,
    onChainTrustScore: 80,
  });

  assert.equal(scoreVprRoute(cheaper, preferences).score, scoreVprRoute(pricier, preferences).score);
  assert.equal(chooseBestVprRoute([pricier, cheaper], preferences)?.peerId, 'cheaper');
});

test('empty rows returns null', () => {
  assert.equal(chooseBestVprRoute([], preferences), null);
});

test('missing price and trust values are handled without mutating rows', () => {
  const row = discoverRow({
    peerId: 'missing-values',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    onChainReputationScore: null,
    onChainTrustScore: null,
  });
  const other = discoverRow({ peerId: 'other' });
  const rows = [row, other];
  const originalRow = structuredClone(row);
  const originalOrder = rows.map((candidate) => candidate.peerId);

  // 100 base - 10 unknown-price penalty; unknown price must not score as free.
  assert.equal(scoreVprRoute(row, preferences).score, 90);
  assert.ok(scoreVprRoute(row, preferences).reasons.includes('price unknown'));
  assert.equal(chooseBestVprRoute(rows, preferences)?.peerId, 'other');
  assert.deepEqual(row, originalRow);
  assert.deepEqual(rows.map((candidate) => candidate.peerId), originalOrder);
});

test('cheap priced route beats unknown-priced route at equal trust', () => {
  const unpriced = discoverRow({
    peerId: 'unpriced',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
  });
  const cheap = discoverRow({ peerId: 'cheap', inputUsdPerMillion: 1, outputUsdPerMillion: 2 });

  assert.equal(chooseBestVprRoute([unpriced, cheap], preferences)?.peerId, 'cheap');
});

test('known priced route beats unknown route even when trust is lower', () => {
  const unpriced = discoverRow({
    peerId: 'unpriced',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    onChainTrustScore: 100,
  });
  const cheap = discoverRow({
    peerId: 'cheap',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    onChainTrustScore: 50,
  });

  assert.equal(scoreVprRoute(unpriced, preferences).score, 110);
  assert.equal(scoreVprRoute(cheap, preferences).score, 107);
  assert.equal(chooseBestVprRoute([unpriced, cheap], preferences)?.peerId, 'cheap');
});
