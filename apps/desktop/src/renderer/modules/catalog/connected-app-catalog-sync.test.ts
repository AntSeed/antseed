import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';

import { createInitialUiState, type DiscoverRow, type VprModelCatalogEntry } from '../../core/state';
import { favoriteModelKey, VPR_FAVORITES_STORAGE_KEY } from './favorites';
import { connectedAppModelCatalog } from './connected-app-catalog-sync';

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
});

function model(provider: string, serviceId: string, label: string, peerCount: number): VprModelCatalogEntry {
  return {
    provider,
    serviceId,
    label,
    categories: [],
    peerCount,
    minInputUsdPerMillion: 1,
    maxInputUsdPerMillion: 1,
    minOutputUsdPerMillion: 2,
    maxOutputUsdPerMillion: 2,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    expectedSavingsPct: null,
    bestPeerId: null,
  };
}

function discoverRow(peerId: string, provider: string, serviceId: string, inputPrice = 1): DiscoverRow {
  return {
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId,
    categories: [],
    provider,
    protocol: provider === 'openai-responses' ? 'openai-responses' : 'openai-chat-completions',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: '',
    inputUsdPerMillion: inputPrice,
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
  };
}

test('connected app catalog exports the concrete pinned peer provider and service', () => {
  const state = createInitialUiState();
  const entry = model('openai', 'gpt-5.6-sol', 'GPT 5.6 Sol', 2);
  const pinnedPeerId = 'b'.repeat(40);
  state.vprModelCatalog = [entry];
  state.vprRoutableRows = [
    discoverRow('a'.repeat(40), 'openai', 'gpt-5.6-sol', 0.1),
    discoverRow(pinnedPeerId, 'openai-responses', 'openai/gpt-5.6-sol', 0.55),
  ];
  state.vprRouteSelection = {
    model: entry,
    mode: 'pinned-peer',
    peerId: pinnedPeerId,
  };

  assert.deepEqual(connectedAppModelCatalog(state), {
    models: [{ provider: 'openai-responses', id: 'openai/gpt-5.6-sol', name: 'GPT 5.6 Sol', peerId: pinnedPeerId }],
  });
});

test('connected app catalog contains favorites plus recommended models', () => {
  const state = createInitialUiState();
  state.vprModelCatalog = [
    model('openai', 'gpt-5.6-sol', 'GPT 5.6 Sol', 2),
    model('openai', 'deepseek-v4', 'DeepSeek V4', 3),
    model('openai', 'custom-user-model', 'Custom User Model', 1),
  ];
  state.vprRoutableRows = [
    discoverRow('a'.repeat(40), 'openai', 'custom-user-model'),
    discoverRow('b'.repeat(40), 'openai', 'gpt-5.6-sol'),
    discoverRow('c'.repeat(40), 'openai', 'deepseek-v4'),
  ];
  localStorage.setItem(VPR_FAVORITES_STORAGE_KEY, JSON.stringify([
    favoriteModelKey('openai', 'custom-user-model'),
  ]));

  assert.deepEqual(connectedAppModelCatalog(state), {
    models: [
      { provider: 'openai', id: 'custom-user-model', name: 'Custom User Model', peerId: 'a'.repeat(40) },
      { provider: 'openai', id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', peerId: 'b'.repeat(40) },
      { provider: 'openai', id: 'deepseek-v4', name: 'DeepSeek V4', peerId: 'c'.repeat(40) },
    ],
  });
});
