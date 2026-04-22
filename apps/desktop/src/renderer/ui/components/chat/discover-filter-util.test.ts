import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesSearch, matchesMaxInputPrice, matchesMaxOutputPrice,
  matchesMinStake,
  matchesLastSeen, matchesLastSettled,
  matchesMinChannels, rowChannelCount,
  applyFilters, applySort, paginate, totalPagesFor,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
} from './discover-filter-util';
import type { DiscoverRow } from '../../../core/state';

function mkRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  return {
    rowKey: 'p:s',
    serviceId: 's', serviceLabel: 'Service', categories: [],
    provider: 'openai', protocol: 'openai-chat-completions',
    peerId: 'p', peerEvmAddress: '0xp', peerDisplayName: 'Peer', peerLabel: 'Peer',
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null,
    lifetimeSessions: 0, lifetimeRequests: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0,
    lifetimeFirstSessionAt: null, lifetimeLastSessionAt: null,
    onChainChannelCount: null,
    agentId: 1, stakeUsdc: '0', stakedAt: 0,
    onChainActiveChannelCount: 0, onChainGhostCount: 0, onChainTotalVolumeUsdc: '0', onChainLastSettledAt: 0,
    networkRequests: null, networkInputTokens: null, networkOutputTokens: null,
    selectionValue: '',
    ...overrides,
  };
}

test('matchesSearch finds query in service, peer, categories', () => {
  const r = mkRow({ serviceLabel: 'GPT-5', peerLabel: 'Test Peer', categories: ['chat', 'math'] });
  assert.ok(matchesSearch(r, 'gpt'));
  assert.ok(matchesSearch(r, 'test'));
  assert.ok(matchesSearch(r, 'math'));
  assert.ok(!matchesSearch(r, 'zzz'));
});

test('matchesMaxInputPrice filters rows by the input slider ceiling', () => {
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 5 }), MAX_INPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: null }), MAX_INPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.3 }), 0.5));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.5 }), 0.5));
  assert.ok(!matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.6 }), 0.5));
  assert.ok(!matchesMaxInputPrice(mkRow({ inputUsdPerMillion: null }), 0.5));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0 }), 0));
  assert.ok(!matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.05 }), 0));
});

test('matchesMaxOutputPrice filters rows by the output slider ceiling', () => {
  assert.ok(matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: 20 }), MAX_OUTPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: null }), MAX_OUTPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: 0.4 }), 0.6));
  assert.ok(!matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: 0.7 }), 0.6));
  assert.ok(!matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: null }), 0.6));
});

test('matchesMinStake compares base-6 USDC bigint to slider value', () => {
  assert.ok(matchesMinStake(mkRow({ stakeUsdc: '10000000' }), 10));
  assert.ok(!matchesMinStake(mkRow({ stakeUsdc: '9000000' }), 10));
  assert.ok(matchesMinStake(mkRow({ stakeUsdc: '0' }), 0));
});

test('matchesLastSeen uses lifetimeLastSessionAt in ms', () => {
  const now = 10_000_000_000;
  const hourAgo = now - 3600 * 1000;
  const tenDaysAgo = now - 10 * 86_400 * 1000;
  assert.ok(matchesLastSeen(mkRow({ lifetimeLastSessionAt: null }), 'any', now));
  assert.ok(!matchesLastSeen(mkRow({ lifetimeLastSessionAt: null }), 'today', now));
  assert.ok(matchesLastSeen(mkRow({ lifetimeLastSessionAt: hourAgo }), 'today', now));
  assert.ok(!matchesLastSeen(mkRow({ lifetimeLastSessionAt: tenDaysAgo }), 'week', now));
  assert.ok(matchesLastSeen(mkRow({ lifetimeLastSessionAt: tenDaysAgo }), 'month', now));
});

test('matchesLastSettled uses onChainLastSettledAt in seconds', () => {
  const nowMs = 10_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const dayAgoSec = nowSec - 86_400;
  const monthAgoSec = nowSec - 86_400 * 40;
  assert.ok(matchesLastSettled(mkRow({ onChainLastSettledAt: 0 }), 'any', nowMs));
  assert.ok(!matchesLastSettled(mkRow({ onChainLastSettledAt: 0 }), 'today', nowMs));
  assert.ok(!matchesLastSettled(mkRow({ onChainLastSettledAt: dayAgoSec }), 'today', nowMs));
  assert.ok(matchesLastSettled(mkRow({ onChainLastSettledAt: dayAgoSec }), 'week', nowMs));
  assert.ok(!matchesLastSettled(mkRow({ onChainLastSettledAt: monthAgoSec }), 'month', nowMs));
});

test('rowChannelCount uses the larger of active vs metadata channel count', () => {
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 20 })), 20);
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 0, onChainChannelCount: 25 })), 25);
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 5, onChainChannelCount: 8 })), 8);
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 0, onChainChannelCount: null })), 0);
});

test('matchesMinChannels gates rows by channel-count threshold', () => {
  assert.ok(matchesMinChannels(mkRow({ onChainActiveChannelCount: 20 }), 20));
  assert.ok(matchesMinChannels(mkRow({ onChainActiveChannelCount: 0, onChainChannelCount: 25 }), 20));
  assert.ok(!matchesMinChannels(mkRow({ onChainActiveChannelCount: 5, onChainChannelCount: 8 }), 20));
  // A threshold of zero always passes, regardless of on-chain state
  assert.ok(matchesMinChannels(mkRow({ onChainActiveChannelCount: 0, onChainChannelCount: null }), 0));
});

test('applyFilters composes all predicates', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', inputUsdPerMillion: 0 }),
    mkRow({ serviceLabel: 'B', inputUsdPerMillion: 10, categories: ['coding'] }),
  ];
  const filtered = applyFilters(rows, {
    search: '', categorySet: new Set(['coding']), peerSet: new Set(),
    maxInputPrice: MAX_INPUT_PRICE_SLIDER_USD,
    maxOutputPrice: MAX_OUTPUT_PRICE_SLIDER_USD,
    chattedOnly: false,
    minStakeUsdc: 0,
    lastSeenWindow: 'any', lastSettledWindow: 'any',
    minOnChainChannels: 0,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.serviceLabel, 'B');
});

test('applySort channelsDesc orders by channel count', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', onChainActiveChannelCount: 5 }),
    mkRow({ serviceLabel: 'B', onChainActiveChannelCount: 50 }),
    mkRow({ serviceLabel: 'C', onChainActiveChannelCount: 20 }),
  ];
  const sorted = applySort(rows, 'channelsDesc', 'desc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['B', 'C', 'A']);
});

test('applySort recentlyUsed floats chatted-with rows, then by lastSession desc', () => {
  const rows = [
    mkRow({ serviceLabel: 'Zeta', lifetimeSessions: 0 }),
    mkRow({ serviceLabel: 'Alpha', lifetimeSessions: 1, lifetimeLastSessionAt: 100 }),
    mkRow({ serviceLabel: 'Beta', lifetimeSessions: 2, lifetimeLastSessionAt: 200 }),
  ];
  const sorted = applySort(rows, 'recentlyUsed', 'desc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['Beta', 'Alpha', 'Zeta']);
});

test('applySort serviceAsc sorts alphabetically', () => {
  const rows = [mkRow({ serviceLabel: 'C' }), mkRow({ serviceLabel: 'A' }), mkRow({ serviceLabel: 'B' })];
  const sorted = applySort(rows, 'serviceAsc', 'asc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['A', 'B', 'C']);
});

test('applySort priceAsc sorts by combined input+output price ascending', () => {
  const rows = [
    mkRow({ inputUsdPerMillion: 1, outputUsdPerMillion: 4 }), // 5
    mkRow({ inputUsdPerMillion: 2, outputUsdPerMillion: 1 }), // 3
    mkRow({ inputUsdPerMillion: 3, outputUsdPerMillion: 5 }), // 8
  ];
  const sorted = applySort(rows, 'priceAsc', 'asc');
  assert.deepEqual(sorted.map((r) => (r.inputUsdPerMillion ?? 0) + (r.outputUsdPerMillion ?? 0)), [3, 5, 8]);
});

test('applySort priceDesc sorts by combined price descending', () => {
  const rows = [
    mkRow({ inputUsdPerMillion: 1, outputUsdPerMillion: 4 }), // 5
    mkRow({ inputUsdPerMillion: 2, outputUsdPerMillion: 1 }), // 3
    mkRow({ inputUsdPerMillion: 3, outputUsdPerMillion: 5 }), // 8
  ];
  const sorted = applySort(rows, 'priceDesc', 'desc');
  assert.deepEqual(sorted.map((r) => (r.inputUsdPerMillion ?? 0) + (r.outputUsdPerMillion ?? 0)), [8, 5, 3]);
});

test('paginate returns the right slice and totalPagesFor rounds up', () => {
  const items = Array.from({ length: 23 }, (_, i) => i);
  assert.deepEqual(paginate(items, 1, 10), Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(paginate(items, 3, 10), [20, 21, 22]);
  assert.equal(totalPagesFor(23, 10), 3);
  assert.equal(totalPagesFor(0, 10), 1);
});
