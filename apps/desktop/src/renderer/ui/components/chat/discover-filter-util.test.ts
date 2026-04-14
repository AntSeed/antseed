import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesSearch, matchesMaxInputPrice, matchesMaxOutputPrice,
  matchesCachedOnly, matchesMinStake,
  matchesLastSeen, matchesLastSettled,
  matchesMinChannels, matchesMinRequests, matchesMinTokens,
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

test('matchesCachedOnly requires cached < input', () => {
  assert.ok(matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1 }), true));
  assert.ok(!matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: null }), true));
  assert.ok(!matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1 }), true));
  assert.ok(matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: null }), false));
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

test('matchesMinChannels compares onChainActiveChannelCount to slider value', () => {
  assert.ok(matchesMinChannels(mkRow({ onChainActiveChannelCount: 5 }), 5));
  assert.ok(!matchesMinChannels(mkRow({ onChainActiveChannelCount: 3 }), 5));
  assert.ok(!matchesMinChannels(mkRow({ onChainActiveChannelCount: 0 }), 1));
  assert.ok(matchesMinChannels(mkRow({ onChainActiveChannelCount: 0 }), 0));
});

test('matchesMinRequests parses networkRequests bigint', () => {
  assert.ok(matchesMinRequests(mkRow({ networkRequests: '100' }), 100));
  assert.ok(!matchesMinRequests(mkRow({ networkRequests: '50' }), 100));
  assert.ok(!matchesMinRequests(mkRow({ networkRequests: null }), 100));
  assert.ok(matchesMinRequests(mkRow({ networkRequests: null }), 0));
});

test('matchesMinTokens sums input+output token strings', () => {
  assert.ok(matchesMinTokens(mkRow({ networkInputTokens: '600', networkOutputTokens: '500' }), 1000));
  assert.ok(!matchesMinTokens(mkRow({ networkInputTokens: '300', networkOutputTokens: '200' }), 1000));
  assert.ok(matchesMinTokens(mkRow({ networkInputTokens: null, networkOutputTokens: null }), 0));
  assert.ok(!matchesMinTokens(mkRow({ networkInputTokens: null, networkOutputTokens: null }), 1));
});

test('applyFilters composes all predicates', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', inputUsdPerMillion: 0 }),
    mkRow({ serviceLabel: 'B', inputUsdPerMillion: 10, categories: ['coding'] }),
  ];
  const filtered = applyFilters(rows, {
    search: '', categorySet: new Set(['coding']),
    maxInputPrice: MAX_INPUT_PRICE_SLIDER_USD,
    maxOutputPrice: MAX_OUTPUT_PRICE_SLIDER_USD,
    cachedOnly: false, chattedOnly: false,
    minStakeUsdc: 0,
    lastSeenWindow: 'any', lastSettledWindow: 'any',
    minChannels: 0, minRequests: 0, minTokens: 0,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.serviceLabel, 'B');
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

test('applySort inputDesc reverses input price order', () => {
  const rows = [mkRow({ inputUsdPerMillion: 1 }), mkRow({ inputUsdPerMillion: 5 }), mkRow({ inputUsdPerMillion: 3 })];
  const sorted = applySort(rows, 'inputDesc', 'desc');
  assert.deepEqual(sorted.map((r) => r.inputUsdPerMillion), [5, 3, 1]);
});

test('paginate returns the right slice and totalPagesFor rounds up', () => {
  const items = Array.from({ length: 23 }, (_, i) => i);
  assert.deepEqual(paginate(items, 1, 10), Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(paginate(items, 3, 10), [20, 21, 22]);
  assert.equal(totalPagesFor(23, 10), 3);
  assert.equal(totalPagesFor(0, 10), 1);
});
