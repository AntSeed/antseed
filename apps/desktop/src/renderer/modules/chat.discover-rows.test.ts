import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDiscoverRow, projectRowsToChatServiceOptions } from './discover-rows.js';

test('normalizeDiscoverRow rejects entries with missing peerId or serviceId', () => {
  assert.equal(normalizeDiscoverRow({}), null);
  assert.equal(normalizeDiscoverRow({ peerId: 'abc' }), null);
  assert.equal(normalizeDiscoverRow({ serviceId: 'gpt-5' }), null);
});

test('normalizeDiscoverRow populates all numeric defaults to 0 / null', () => {
  const row = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-5',
    peerEvmAddress: '0xabc123',
    agentId: 1,
  });
  assert.ok(row);
  assert.equal(row!.lifetimeSessions, 0);
  assert.equal(row!.stakeUsdc, '0');
  assert.equal(row!.cachedInputUsdPerMillion, null);
});

test('projectRowsToChatServiceOptions dedupes by (provider, service, peer)', () => {
  const rows = [
    { rowKey: 'p1:s1', serviceId: 's1', serviceLabel: 's1', categories: [], provider: 'openai', protocol: 'openai-chat-completions', peerId: 'p1', peerEvmAddress: '', peerDisplayName: null, peerLabel: '', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null, lifetimeSessions: 0, lifetimeRequests: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0, lifetimeFirstSessionAt: null, lifetimeLastSessionAt: null, onChainChannelCount: null, agentId: 1, stakeUsdc: '0', stakedAt: 0, onChainActiveChannelCount: 0, onChainGhostCount: 0, onChainTotalVolumeUsdc: '0', onChainLastSettledAt: 0, selectionValue: 'openai\u0001s1\u0001p1' },
    { rowKey: 'p1:s1', serviceId: 's1', serviceLabel: 's1', categories: [], provider: 'openai', protocol: 'openai-chat-completions', peerId: 'p1', peerEvmAddress: '', peerDisplayName: null, peerLabel: '', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null, lifetimeSessions: 0, lifetimeRequests: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0, lifetimeFirstSessionAt: null, lifetimeLastSessionAt: null, onChainChannelCount: null, agentId: 1, stakeUsdc: '0', stakedAt: 0, onChainActiveChannelCount: 0, onChainGhostCount: 0, onChainTotalVolumeUsdc: '0', onChainLastSettledAt: 0, selectionValue: 'openai\u0001s1\u0001p1' },
  ];
  const options = projectRowsToChatServiceOptions(rows);
  assert.equal(options.length, 1);
});
