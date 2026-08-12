import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { DiscoverRow, VprRouteSelection } from '../../core/state';
import { modelPinKey } from '../routing/model-pins.js';
import { pinnedSellerLabel, pinnedSellerLabels } from './view-models.js';

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const peerId = overrides.peerId ?? 'p1';
  const serviceId = overrides.serviceId ?? 'gpt-test';
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
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
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
    selectionValue: `${provider}${serviceId}${peerId}`,
    ...overrides,
  };
}

const pinned: VprRouteSelection = {
  model: { provider: 'openai', serviceId: 'gpt-test', label: 'GPT Test', categories: [] },
  mode: 'pinned-peer',
  peerId: 'p1',
};

test('auto mode has no pinned seller', () => {
  const rows = [discoverRow({ peerDisplayName: 'Hermes' })];
  assert.equal(pinnedSellerLabel(rows, { ...pinned, mode: 'auto', peerId: null }), null);
});

test('pinned mode names the seller of the pinned peer', () => {
  const rows = [
    discoverRow({ peerId: 'p0', peerDisplayName: 'Other' }),
    discoverRow({ peerId: 'p1', peerDisplayName: 'Hermes' }),
  ];
  assert.equal(pinnedSellerLabel(rows, pinned), 'Hermes');
});

test('falls back to peerLabel, then a short peer id', () => {
  assert.equal(pinnedSellerLabel([discoverRow({ peerLabel: 'seller-one' })], pinned), 'seller-one');
  assert.equal(
    pinnedSellerLabel([], { ...pinned, peerId: '0x1234567890abcdef1234' }),
    '0x123456...1234',
  );
});

test('ignores peers serving a different model', () => {
  const rows = [discoverRow({ peerId: 'p1', serviceId: 'other-model', peerDisplayName: 'Hermes' })];
  assert.equal(pinnedSellerLabel(rows, pinned), 'p1');
});

test('labels every listed model that remembers a pin', () => {
  const rows = [
    discoverRow({ peerId: 'p1', serviceId: 'gpt-test', peerDisplayName: 'Hermes' }),
    discoverRow({ peerId: 'p2', provider: 'anthropic', serviceId: 'fable-5', peerDisplayName: 'Athena' }),
  ];
  const pins = {
    [modelPinKey('openai', 'gpt-test')]: 'p1',
    [modelPinKey('anthropic', 'fable-5')]: 'p2',
  };
  const labels = pinnedSellerLabels(rows, pins, [
    { provider: 'openai', serviceId: 'gpt-test' },
    { provider: 'anthropic', serviceId: 'fable-5' },
  ]);

  assert.equal(labels.get(modelPinKey('openai', 'gpt-test')), 'Hermes');
  assert.equal(labels.get(modelPinKey('anthropic', 'fable-5')), 'Athena');
});

test('a pin whose seller no longer serves the model is left unlabelled', () => {
  const rows = [discoverRow({ peerId: 'p2', serviceId: 'gpt-test', peerDisplayName: 'Athena' })];
  const pins = { [modelPinKey('openai', 'gpt-test')]: 'p1' };
  const labels = pinnedSellerLabels(rows, pins, [{ provider: 'openai', serviceId: 'gpt-test' }]);

  assert.equal(labels.size, 0);
});

test('models without a pin get no label', () => {
  const rows = [discoverRow({ peerId: 'p1', serviceId: 'gpt-test', peerDisplayName: 'Hermes' })];
  const labels = pinnedSellerLabels(rows, {}, [{ provider: 'openai', serviceId: 'gpt-test' }]);

  assert.equal(labels.size, 0);
});
