import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow, VprSelectedModel } from '../../core/state';
import {
  findCatalogEntry,
  projectRowsToVprModelCatalog,
  selectDefaultVprModel,
} from './model-catalog.js';

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
    onChainTrustScore: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    selectionValue: `${provider}\u0001${serviceId}\u0001${peerId}`,
    ...overrides,
  };
}

test('groups two peers with the same provider/service into one catalog entry', () => {
  const rows = [
    discoverRow({ peerId: 'p1', serviceLabel: 'GPT Test', categories: ['chat'] }),
    discoverRow({ peerId: 'p2', serviceLabel: '', categories: ['code', 'chat'] }),
  ];

  const catalog = projectRowsToVprModelCatalog(rows);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].provider, 'openai');
  assert.equal(catalog[0].serviceId, 's1');
  assert.equal(catalog[0].label, 'GPT Test');
  assert.equal(catalog[0].peerCount, 2);
  assert.deepEqual(catalog[0].categories, ['chat', 'code']);
});

test('price min/max ignores null values', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'p1', inputUsdPerMillion: null, outputUsdPerMillion: 9 }),
    discoverRow({ peerId: 'p2', inputUsdPerMillion: 2, outputUsdPerMillion: null }),
    discoverRow({ peerId: 'p3', inputUsdPerMillion: 5, outputUsdPerMillion: 4 }),
  ]);

  assert.equal(entry.minInputUsdPerMillion, 5);
  assert.equal(entry.maxInputUsdPerMillion, 5);
  assert.equal(entry.minOutputUsdPerMillion, 4);
  assert.equal(entry.maxOutputUsdPerMillion, 9);
  assert.equal(entry.minCachedInputUsdPerMillion, null);
  assert.equal(entry.maxCachedInputUsdPerMillion, null);
});

test('catalog input/output prices come from the best route while cached price spans the group', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'low-input', inputUsdPerMillion: 1, outputUsdPerMillion: 20, cachedInputUsdPerMillion: 0.1 }),
    discoverRow({ peerId: 'low-output', inputUsdPerMillion: 8, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.8 }),
  ]);

  assert.equal(entry.bestPeerId, 'low-output');
  assert.equal(entry.minInputUsdPerMillion, 8);
  assert.equal(entry.minOutputUsdPerMillion, 2);
  assert.equal(entry.minCachedInputUsdPerMillion, 0.1);
  assert.equal(entry.maxCachedInputUsdPerMillion, 0.8);
});

test('catalog retains cached-input pricing from a non-representative unified route', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({
      peerId: 'cheap-coding-only',
      serviceId: 'fable-5-coding-only',
      inputUsdPerMillion: 0.45,
      outputUsdPerMillion: 1.15,
      cachedInputUsdPerMillion: null,
    }),
    discoverRow({
      peerId: 'cached-fable',
      serviceId: 'claude-fable-5',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cachedInputUsdPerMillion: 0.6,
    }),
  ]);

  assert.equal(entry.bestPeerId, 'cheap-coding-only');
  assert.equal(entry.serviceId, 'fable-5-coding-only');
  assert.equal(entry.minCachedInputUsdPerMillion, 0.6);
  assert.equal(entry.maxCachedInputUsdPerMillion, 0.6);
});

test('expectedSavingsPct is 50 for totals 10 and 20', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'p1', inputUsdPerMillion: 4, outputUsdPerMillion: 6 }),
    discoverRow({ peerId: 'p2', inputUsdPerMillion: 8, outputUsdPerMillion: 12 }),
  ]);

  assert.equal(entry.expectedSavingsPct, 50);
});

test('bestPeerId picks the lowest priced peer', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'expensive', inputUsdPerMillion: 8, outputUsdPerMillion: 12 }),
    discoverRow({ peerId: 'cheap', inputUsdPerMillion: 4, outputUsdPerMillion: 6 }),
  ]);

  assert.equal(entry.bestPeerId, 'cheap');
});

test('selectDefaultVprModel preserves an existing selected model when present', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'anthropic', serviceId: 'claude', serviceLabel: 'Claude' }),
  ]);
  const current: VprSelectedModel = {
    provider: 'anthropic',
    serviceId: 'claude',
    label: 'Pinned Label',
    categories: ['existing'],
  };

  assert.equal(selectDefaultVprModel(catalog, current), current);
});

test('selectDefaultVprModel falls back to the first sorted catalog entry', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'z', serviceLabel: 'Zed', peerId: 'p1' }),
    discoverRow({ provider: 'anthropic', serviceId: 'a', serviceLabel: 'Alpha', peerId: 'p2' }),
    discoverRow({ provider: 'anthropic', serviceId: 'a', serviceLabel: 'Alpha', peerId: 'p3' }),
  ]);

  assert.deepEqual(selectDefaultVprModel(catalog, null), {
    provider: 'anthropic',
    serviceId: 'a',
    label: 'Alpha',
    categories: [],
  });
});

test('selectDefaultVprModel prefers a free model for the first selection', () => {
  const catalog = projectRowsToVprModelCatalog([
    // Popular paid frontier model (more peers = sorted first).
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p2' }),
    // Free model with a single seller.
    discoverRow({
      provider: 'openai',
      serviceId: 'free-mini',
      serviceLabel: 'Free Mini',
      peerId: 'p3',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
  ]);

  assert.equal(selectDefaultVprModel(catalog, null)?.serviceId, 'free-mini');
});

test('findCatalogEntry returns null when the service is absent', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 's1' }),
  ]);

  assert.equal(findCatalogEntry(catalog, 'openai', 'other-model'), null);
});

test('findCatalogEntry matches canonical serviceId variants across providers', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna' }),
  ]);

  assert.equal(findCatalogEntry(catalog, 'other-provider', 'GPT 5.6 Luna')?.serviceId, 'gpt-5.6-luna');
});

test('catalog classifies image services without aggregating peer capabilities', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({
      serviceId: 'gpt-image-test',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'], supportedParameters: ['quality'] },
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.08,
    }),
  ]);

  assert.equal(entry.kind, 'image');
  assert.deepEqual(entry.protocols, ['openai-images']);
  assert.equal(entry.minImageUsdPerImage, 0.04);
  assert.equal(entry.maxImageUsdPerImage, 0.08);
  assert.equal('capabilities' in entry, false);
});

test('catalog chooses the cheapest image seller by per-image pricing', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({
      peerId: 'expensive-image-peer',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'] },
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      minImageUsdPerImage: 0.08,
      maxImageUsdPerImage: 0.12,
    }),
    discoverRow({
      peerId: 'cheap-image-peer',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'] },
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.06,
    }),
  ]);

  assert.equal(entry.bestPeerId, 'cheap-image-peer');
  assert.equal(entry.minImageUsdPerImage, 0.04);
  assert.equal(entry.maxImageUsdPerImage, 0.12);
});

test('selectDefaultVprModel ignores image-only services for the chat fallback', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({
      serviceId: 'image-free',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'] },
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
    discoverRow({ serviceId: 'text-paid', peerId: 'p2' }),
  ]);

  assert.equal(selectDefaultVprModel(catalog, null)?.serviceId, 'text-paid');
});

test('catalog aggregates serviceId variants of the same model', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna', peerId: 'p1', inputUsdPerMillion: 4, outputUsdPerMillion: 6 }),
    discoverRow({ provider: 'openai-responses', serviceId: 'GPT 5.6 Luna', peerId: 'p2', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }),
    discoverRow({ provider: 'openai', serviceId: 'openai/gpt-5.6-luna', peerId: 'p3', inputUsdPerMillion: 8, outputUsdPerMillion: 12 }),
  ]);

  assert.equal(catalog.length, 1);
  const [entry] = catalog;
  assert.equal(entry.peerCount, 3);
  // Representative provider/serviceId come from the best priced route so
  // dispatching (bestPeerId, serviceId) matches what that peer advertises.
  assert.equal(entry.bestPeerId, 'p2');
  assert.equal(entry.serviceId, 'GPT 5.6 Luna');
  assert.equal(entry.provider, 'openai-responses');
  assert.equal(entry.label, 'GPT 5.6 Luna');
});

test('catalog uses the clean Fable name even when coding-only is the cheapest route', () => {
  const rows = [
    discoverRow({
      provider: 'claude-oauth',
      serviceId: 'fable-5-coding-only',
      peerId: 'cheap',
      inputUsdPerMillion: 0.45,
      outputUsdPerMillion: 1.15,
    }),
    discoverRow({
      provider: 'openai',
      serviceId: 'claude-fable-5',
      peerId: 'branded',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
    }),
    discoverRow({
      provider: 'openai',
      serviceId: 'fable-5',
      peerId: 'plain',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
    }),
  ];

  for (const orderedRows of [rows, [...rows].reverse()]) {
    const [entry] = projectRowsToVprModelCatalog(orderedRows);
    assert.equal(entry.label, 'Fable 5');
    assert.equal(entry.bestPeerId, 'cheap');
    assert.equal(entry.serviceId, 'fable-5-coding-only');
    assert.equal(entry.provider, 'claude-oauth');
  }
});
