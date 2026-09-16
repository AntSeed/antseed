import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createInitialUiState, type DiscoverRow, type VprRouteSelection } from '../../core/state.js';
import { buyerDefaultRoutePayload, syncBuyerDefaultRoute, type VprRouteTarget } from './proxy-sync.js';
import { currentAutoRouteEntry, withAutoRouterCatalogEntry } from './auto-router.js';
import type { RouterPluginInfo } from '../../types/bridge.js';

/**
 * `currentAutoRouteEntry`/`isAutoRouterSelected` only recognize an Auto
 * entry once a real router plugin has actually been resolved, so this file
 * seeds one explicitly instead of relying on a default.
 */
const LEVANTO_LIKE_ROUTER: RouterPluginInfo = {
  package: '@antseed/router-levanto',
  version: '0.0.1',
  name: 'levanto',
  displayName: 'Levanto Router',
  description: 'test fixture',
  autoRouteServiceId: 'levanto-auto',
};
withAutoRouterCatalogEntry(
  [],
  { selectedRouterPackage: LEVANTO_LIKE_ROUTER.package },
  [LEVANTO_LIKE_ROUTER],
);

const model = {
  provider: 'openai',
  serviceId: 'gpt-5.6-sol',
  label: 'GPT 5.6 Sol',
  categories: [],
};

const target: VprRouteTarget = {
  peerId: 'a'.repeat(40),
  model: 'openai-gpt-56-sol',
  servedModels: ['openai-gpt-56-sol'],
};

test('desktop Auto syncs a model-only buyer route', () => {
  const selection: VprRouteSelection = { model, mode: 'auto', peerId: null };
  assert.deepEqual(buyerDefaultRoutePayload(selection, target), {
    service: 'openai-gpt-56-sol',
  });
});

test('desktop pinned mode syncs the selected peer and its advertised service id', () => {
  const selection: VprRouteSelection = { model, mode: 'pinned-peer', peerId: target.peerId };
  assert.deepEqual(buyerDefaultRoutePayload(selection, target), {
    peerId: target.peerId,
    service: 'openai-gpt-56-sol',
  });
});

test('desktop Auto replaces a stale coding-only selection with an unrestricted route', async () => {
  const uiState = createInitialUiState();
  const row = (serviceId: string, peerId: string, effectiveReputationScore: number): DiscoverRow => ({
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId,
    categories: [],
    provider: 'openai',
    protocol: 'openai-chat-completions',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: peerId,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
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
    effectiveReputationScore,
    onChainReputationScore: effectiveReputationScore,
    onChainTrustScore: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    peerCooldownUntil: null,
    peerFailureStreak: 0,
    peerLastFailureReason: null,
    selectionValue: `openai\u0001${serviceId}\u0001${peerId}`,
  });
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'fable-5-coding-only', label: 'Claude Fable 5', categories: [] },
    mode: 'auto',
    peerId: null,
  };
  uiState.vprModelCatalog = [{
    provider: 'openai',
    serviceId: 'claude-fable-5',
    label: 'Claude Fable 5',
    peerCount: 2,
    categories: [],
    kind: 'text',
    protocols: ['openai-chat-completions'],
    minInputUsdPerMillion: 1,
    maxInputUsdPerMillion: 1,
    minOutputUsdPerMillion: 1,
    maxOutputUsdPerMillion: 1,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    bestPeerId: 'full-peer',
  }];
  uiState.vprRoutableRows = [
    row('fable-5-coding-only', 'restricted-peer', 99),
    row('claude-fable-5', 'full-peer', 75),
  ];
  const payloads: unknown[] = [];

  await syncBuyerDefaultRoute({
    chatSetBuyerDefaultRoute: async (payload) => {
      payloads.push(payload);
      return { ok: true };
    },
  }, uiState);

  assert.deepEqual(payloads, [{ service: 'claude-fable-5' }]);
});

test('desktop never syncs a peer-pinned default route while Auto is selected, even with a stale pinned-peer mode', async () => {
  const uiState = createInitialUiState();
  // Simulates a leftover `mode: 'pinned-peer'` from an earlier explicit peer
  // pin, with the selection since switched back to the Auto sentinel --
  // without the Auto guard, resolveRouteTarget's peerId fallback would still
  // produce a target and post `<peerId>@levanto-auto` to the buyer proxy.
  uiState.vprRouteSelection = {
    model: currentAutoRouteEntry(),
    mode: 'pinned-peer',
    peerId: 'a'.repeat(40),
  };
  const payloads: unknown[] = [];

  await syncBuyerDefaultRoute({
    chatSetBuyerDefaultRoute: async (payload) => {
      payloads.push(payload);
      return { ok: true };
    },
  }, uiState);

  assert.deepEqual(payloads, []);
});

test('desktop clears the buyer default route while Auto is selected', async () => {
  const uiState = createInitialUiState();
  uiState.vprRouteSelection = { model: currentAutoRouteEntry(), mode: 'auto', peerId: null };
  let clearCalls = 0;
  const setPayloads: unknown[] = [];

  await syncBuyerDefaultRoute({
    chatSetBuyerDefaultRoute: async (payload) => {
      setPayloads.push(payload);
      return { ok: true };
    },
    chatClearBuyerDefaultRoute: async () => {
      clearCalls += 1;
      return { ok: true };
    },
  }, uiState);

  assert.equal(clearCalls, 1);
  assert.deepEqual(setPayloads, []);
});

test('desktop does not clear the buyer default route for a non-Auto null target (e.g. no route found yet)', async () => {
  const uiState = createInitialUiState();
  // A real model selection with no advertising peer in vprRoutableRows --
  // resolveRouteTarget returns null here too, but for an unrelated reason
  // (no route found), which must leave any existing default route alone
  // rather than being swept up by the Auto-only clear.
  uiState.vprRouteSelection = { model, mode: 'auto', peerId: null };
  uiState.vprRoutableRows = [];
  let clearCalls = 0;

  await syncBuyerDefaultRoute({
    chatSetBuyerDefaultRoute: async () => ({ ok: true }),
    chatClearBuyerDefaultRoute: async () => {
      clearCalls += 1;
      return { ok: true };
    },
  }, uiState);

  assert.equal(clearCalls, 0);
});
