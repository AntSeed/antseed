import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesSearch, matchesPriceBucket, matchesCachedOnly, matchesMinStake,
  applyFilters, applySort, paginate, totalPagesFor,
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

test('matchesPriceBucket handles all buckets', () => {
  assert.ok(matchesPriceBucket(mkRow({ inputUsdPerMillion: 0 }), 'free'));
  assert.ok(!matchesPriceBucket(mkRow({ inputUsdPerMillion: 0.5 }), 'free'));
  assert.ok(matchesPriceBucket(mkRow({ inputUsdPerMillion: 0.5 }), 'lt1'));
  assert.ok(matchesPriceBucket(mkRow({ inputUsdPerMillion: 3 }), '1to5'));
  assert.ok(matchesPriceBucket(mkRow({ inputUsdPerMillion: 10 }), 'gt5'));
  assert.ok(matchesPriceBucket(mkRow({ inputUsdPerMillion: 0 }), 'any'));
});

test('matchesCachedOnly requires cached < input', () => {
  assert.ok(matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1 }), true));
  assert.ok(!matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: null }), true));
  assert.ok(!matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1 }), true));
  assert.ok(matchesCachedOnly(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: null }), false));
});

test('matchesMinStake compares base-6 USDC bigint to human input', () => {
  assert.ok(matchesMinStake(mkRow({ stakeUsdc: '10000000' }), '10'));
  assert.ok(!matchesMinStake(mkRow({ stakeUsdc: '9000000' }), '10'));
  assert.ok(matchesMinStake(mkRow({ stakeUsdc: '0' }), ''));
});

test('applyFilters composes all predicates', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', inputUsdPerMillion: 0 }),
    mkRow({ serviceLabel: 'B', inputUsdPerMillion: 10, categories: ['coding'] }),
  ];
  const filtered = applyFilters(rows, {
    search: '', categorySet: new Set(['coding']),
    priceBucket: 'gt5', cachedOnly: false, chattedOnly: false, minStakeUsdc: '',
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
