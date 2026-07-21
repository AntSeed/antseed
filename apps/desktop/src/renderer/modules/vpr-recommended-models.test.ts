import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../core/state';
import { projectRowsToVprModelCatalog, selectDefaultVprModel } from './vpr-model-catalog.js';
import { favoriteModelKey } from './vpr-favorites.js';
import { selectFavoriteVprCatalog, selectRecommendedVprCatalog } from './vpr-recommended-models.js';

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
    onChainTrustScore: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    selectionValue: `${provider}${serviceId}${peerId}`,
    ...overrides,
  };
}

test('recommended catalog lists frontier models in lineup order, not popularity', () => {
  const catalog = projectRowsToVprModelCatalog([
    // deepseek is the most popular (2 peers) but gpt-5.6 leads the lineup.
    discoverRow({ provider: 'openai', serviceId: 'deepseek-v4', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'deepseek-v4', peerId: 'p2' }),
    discoverRow({ provider: 'anthropic', serviceId: 'claude-fable-5', peerId: 'p3' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p4' }),
  ]);

  const recommended = selectRecommendedVprCatalog(catalog);

  assert.deepEqual(recommended.map((entry) => entry.serviceId), [
    'gpt-5.6',
    'claude-fable-5',
    'deepseek-v4',
  ]);
});

test('recommended catalog picks one variant per family, preferring the exact model', () => {
  const catalog = projectRowsToVprModelCatalog([
    // Sol is more popular, but the exact family model wins when advertised.
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-sol', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-sol', peerId: 'p2' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p3' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-terra-pro', peerId: 'p4' }),
  ]);

  assert.deepEqual(selectRecommendedVprCatalog(catalog).map((entry) => entry.serviceId), ['gpt-5.6']);
});

test('recommended catalog falls back to the most popular family variant', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-terra', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna', peerId: 'p2' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna', peerId: 'p3' }),
  ]);

  assert.deepEqual(selectRecommendedVprCatalog(catalog).map((entry) => entry.serviceId), ['gpt-5.6-luna']);
});

test('recommended catalog appends free models and drops unknown paid models', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'obscure-paid-model', peerId: 'p2' }),
    discoverRow({
      provider: 'openai',
      serviceId: 'llama-free',
      peerId: 'p3',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
  ]);

  const recommended = selectRecommendedVprCatalog(catalog);

  assert.deepEqual(recommended.map((entry) => entry.serviceId), ['gpt-5.6', 'llama-free']);
});

test('recommended catalog matches lineup names in service labels too', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'zai', serviceId: 'z-flagship', serviceLabel: 'GLM-5.2', peerId: 'p1' }),
    discoverRow({ provider: 'moonshot', serviceId: 'kimi-k3', serviceLabel: 'Kimi K3', peerId: 'p2' }),
  ]);

  const recommended = selectRecommendedVprCatalog(catalog);

  assert.deepEqual(recommended.map((entry) => entry.serviceId), ['kimi-k3', 'z-flagship']);
});

test('selectDefaultVprModel prefers the recommended lineup over raw popularity', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'obscure-model', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'obscure-model', peerId: 'p2' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p3' }),
  ]);

  assert.equal(selectDefaultVprModel(catalog, null)?.serviceId, 'gpt-5.6');
});

test('selectFavoriteVprCatalog returns only starred entries in catalog order', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'obscure-model', peerId: 'p2' }),
  ]);

  const favorites = selectFavoriteVprCatalog(catalog, new Set([favoriteModelKey('openai', 'obscure-model')]));

  assert.deepEqual(favorites.map((entry) => entry.serviceId), ['obscure-model']);
});
