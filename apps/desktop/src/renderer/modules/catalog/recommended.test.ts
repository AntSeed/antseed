import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import { projectRowsToVprModelCatalog, selectDefaultVprModel } from './model-catalog.js';
import { favoriteModelKey } from './favorites.js';
import { isFreeCatalogEntry, selectFavoriteVprCatalog, selectRecommendedVprCatalog } from './recommended.js';

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
    // deepseek is the most popular (2 peers) but trails both lineup slots.
    discoverRow({ provider: 'openai', serviceId: 'deepseek-v4', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'deepseek-v4', peerId: 'p2' }),
    discoverRow({ provider: 'anthropic', serviceId: 'claude-fable-5', peerId: 'p3' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p4' }),
  ]);

  const recommended = selectRecommendedVprCatalog(catalog);

  assert.deepEqual(recommended.map((entry) => entry.serviceId), [
    'claude-fable-5',
    'gpt-5.6',
    'deepseek-v4',
  ]);
});

test('recommended catalog lists named variants separately, each on its own slot', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-sol', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-sol', peerId: 'p2' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna', peerId: 'p3' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p4' }),
  ]);

  // Lineup order: sol, luna, then the generic 5.6 slot landing on the base model.
  assert.deepEqual(selectRecommendedVprCatalog(catalog).map((entry) => entry.serviceId), [
    'gpt-5.6-sol',
    'gpt-5.6-luna',
    'gpt-5.6',
  ]);
});

test('a broad slot falls back to the most popular variant no earlier slot claimed', () => {
  const catalog = projectRowsToVprModelCatalog([
    // No base gpt-5.6 advertised: luna takes its own slot, and the generic
    // slot falls through to terra rather than being starved.
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-terra', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna', peerId: 'p2' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna', peerId: 'p3' }),
  ]);

  assert.deepEqual(selectRecommendedVprCatalog(catalog).map((entry) => entry.serviceId), [
    'gpt-5.6-luna',
    'gpt-5.6-terra',
  ]);
});

test('recommended catalog covers the Claude lineup alongside GPT', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'anthropic', serviceId: 'claude-sonnet-5', peerId: 'p1' }),
    discoverRow({ provider: 'anthropic', serviceId: 'claude-opus-5', peerId: 'p2' }),
    discoverRow({ provider: 'anthropic', serviceId: 'claude-fable-5', peerId: 'p3' }),
    discoverRow({ provider: 'openai', serviceId: 'minimax-m3', peerId: 'p4' }),
  ]);

  assert.deepEqual(selectRecommendedVprCatalog(catalog).map((entry) => entry.serviceId), [
    'claude-opus-5',
    'claude-fable-5',
    'claude-sonnet-5',
    'minimax-m3',
  ]);
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

test('recommended exact matching prefers the base model over a more popular variant', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-terra', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-terra', peerId: 'p2' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', peerId: 'p3' }),
  ]);

  assert.equal(selectRecommendedVprCatalog(catalog)[0]?.serviceId, 'gpt-5.6');
});

test('a paid cached-input rate disqualifies an otherwise free entry', () => {
  const [paidCached] = projectRowsToVprModelCatalog([
    discoverRow({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 5 }),
  ]);
  const [noCached] = projectRowsToVprModelCatalog([
    discoverRow({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: null }),
  ]);
  const [freeCached] = projectRowsToVprModelCatalog([
    discoverRow({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 }),
  ]);

  assert.equal(isFreeCatalogEntry(paidCached!), false);
  assert.equal(isFreeCatalogEntry(noCached!), true);
  assert.equal(isFreeCatalogEntry(freeCached!), true);
});
