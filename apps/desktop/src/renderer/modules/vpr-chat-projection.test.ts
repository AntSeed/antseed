import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  ChatServiceOptionEntry,
  DiscoverRow,
  VprRouteSelection,
  VprRoutingPreferences,
} from '../core/state';
import { findChatOptionForVprSelection, resolveVprChatOption } from './vpr-chat-projection.js';

function option(overrides: Partial<ChatServiceOptionEntry> = {}): ChatServiceOptionEntry {
  return {
    id: 'gpt-test',
    label: 'GPT Test',
    provider: 'openai',
    protocol: 'openai-chat-completions',
    count: 1,
    value: 'openai\u0001gpt-test\u0001peer-1',
    peerId: 'peer-1',
    peerDisplayName: null,
    peerLabel: 'peer-1',
    peerIconUrl: null,
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    cachedInputUsdPerMillion: null,
    categories: [],
    description: '',
    ...overrides,
  };
}

const autoSelection: VprRouteSelection = {
  model: { provider: 'openai', serviceId: 'gpt-test', label: 'GPT Test', categories: [] },
  mode: 'auto',
  peerId: null,
};

test('returns null when VPR selection has no model', () => {
  assert.equal(findChatOptionForVprSelection([option()], { model: null, mode: 'auto', peerId: null }), null);
});

test('auto mode returns the first matching provider and service option', () => {
  const match = option({ peerId: 'peer-2', value: 'openai\u0001gpt-test\u0001peer-2' });

  assert.equal(findChatOptionForVprSelection([match], autoSelection), match);
});

test('pinned peer mismatch returns null', () => {
  assert.equal(
    findChatOptionForVprSelection([option({ peerId: 'peer-2' })], { ...autoSelection, mode: 'pinned-peer', peerId: 'peer-1' }),
    null,
  );
});

const preferences: VprRoutingPreferences = {
  autoRouting: true,
  preferFreePeers: false,
  maxInputUsdPerMillion: 10,
  minTrustScore: 50,
  allowedPeerIds: [],
  blockedPeerIds: [],
};

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const peerId = overrides.peerId ?? 'peer-1';
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

test('auto mode resolves the preference-best peer, not the first option', () => {
  const expensiveFirst = option({ peerId: 'peer-expensive', value: 'openaigpt-testpeer-expensive' });
  const cheap = option({ peerId: 'peer-cheap', value: 'openaigpt-testpeer-cheap' });
  const rows = [
    discoverRow({ peerId: 'peer-expensive', inputUsdPerMillion: 8, outputUsdPerMillion: 8 }),
    discoverRow({ peerId: 'peer-cheap', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }),
  ];

  assert.equal(
    resolveVprChatOption([expensiveFirst, cheap], rows, autoSelection, preferences),
    cheap,
  );
});

test('auto mode falls back to the first matching option when no rows exist', () => {
  const only = option();

  assert.equal(resolveVprChatOption([only], [], autoSelection, preferences), only);
});

test('pinned mode still requires the exact peer', () => {
  const other = option({ peerId: 'peer-2', value: 'openaigpt-testpeer-2' });
  const rows = [discoverRow({ peerId: 'peer-2' })];

  assert.equal(
    resolveVprChatOption([other], rows, { ...autoSelection, mode: 'pinned-peer', peerId: 'peer-1' }, preferences),
    null,
  );
});
