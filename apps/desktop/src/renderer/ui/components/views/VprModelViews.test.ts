import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow, VprModelCatalogEntry } from '../../../core/state';
import {
  filterVprCatalog,
  routesForSelectedModel,
  sortVprCatalog,
} from '../../../modules/vpr-view-models.js';

function catalogEntry(overrides: Partial<VprModelCatalogEntry> = {}): VprModelCatalogEntry {
  return {
    provider: 'openai',
    serviceId: 'gpt-test',
    label: 'GPT Test',
    peerCount: 1,
    categories: [],
    minInputUsdPerMillion: 1,
    maxInputUsdPerMillion: 1,
    minOutputUsdPerMillion: 2,
    maxOutputUsdPerMillion: 2,
    expectedSavingsPct: null,
    bestPeerId: null,
    ...overrides,
  };
}

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const provider = overrides.provider ?? 'openai';
  const serviceId = overrides.serviceId ?? 'gpt-test';
  const peerId = overrides.peerId ?? 'peer-1';

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

test('Explore search finds a model by category', () => {
  const catalog = [
    catalogEntry({ serviceId: 'chat', label: 'Chat Model', categories: ['chat'] }),
    catalogEntry({ serviceId: 'vision', label: 'Vision Model', categories: ['multimodal', 'image'] }),
  ];

  assert.deepEqual(filterVprCatalog(catalog, { search: 'image' }), [catalog[1]]);
});

test('Price sort places lower priced model first', () => {
  const expensive = catalogEntry({
    serviceId: 'expensive',
    label: 'Expensive',
    minInputUsdPerMillion: 5,
    minOutputUsdPerMillion: 6,
  });
  const cheap = catalogEntry({
    serviceId: 'cheap',
    label: 'Cheap',
    minInputUsdPerMillion: 1,
    minOutputUsdPerMillion: 2,
  });

  assert.deepEqual(sortVprCatalog([expensive, cheap], 'Price'), [cheap, expensive]);
});

test('Model route filtering excludes other service IDs but keeps canonical variants', () => {
  const selected = discoverRow({ provider: 'openai', serviceId: 'gpt-test', peerId: 'selected-peer' });
  const otherService = discoverRow({ provider: 'openai', serviceId: 'other-service', peerId: 'other-peer' });
  // Same model advertised under a different provider string and a cosmetic
  // serviceId variant — both are valid routes for the selection.
  const otherProvider = discoverRow({ provider: 'anthropic', serviceId: 'gpt-test', peerId: 'anthropic-peer' });
  const variantKey = discoverRow({ provider: 'openai', serviceId: 'GPT Test', peerId: 'variant-peer' });

  assert.deepEqual(
    routesForSelectedModel([selected, otherService, otherProvider, variantKey], {
      provider: 'openai',
      serviceId: 'gpt-test',
    }),
    [selected, otherProvider, variantKey],
  );
});
