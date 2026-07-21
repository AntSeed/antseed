import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow, VprSelectedModel } from '../core/state';
import {
  findCatalogEntry,
  projectRowsToVprModelCatalog,
  selectDefaultVprModel,
} from './vpr-model-catalog.js';

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
});

test('catalog entry minimum prices come from the same best route', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'low-input', inputUsdPerMillion: 1, outputUsdPerMillion: 20 }),
    discoverRow({ peerId: 'low-output', inputUsdPerMillion: 8, outputUsdPerMillion: 2 }),
  ]);

  assert.equal(entry.bestPeerId, 'low-output');
  assert.equal(entry.minInputUsdPerMillion, 8);
  assert.equal(entry.minOutputUsdPerMillion, 2);
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
