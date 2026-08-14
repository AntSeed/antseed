import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createInitialUiState, type DiscoverRow, type RendererUiState } from '../../core/state';
import type { ApplicationRoutePolicies } from '../../../shared/application-routes';
import type { DesktopBridge } from '../../types/bridge';
import {
  applyVprRouteToConnectedProxy,
  connectVprProfile,
  syncBuyerApplicationRoutes,
} from './proxy-sync.js';

function discoverRow(peerId: string, provider: string, serviceId: string): DiscoverRow {
  return {
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId,
    categories: ['coding'],
    provider,
    protocol: 'openai-responses',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: peerId,
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
  };
}

function routingState(peerId = 'peer-a', serviceId = 'gpt-5.4'): RendererUiState {
  const state = createInitialUiState();
  state.vprRouteSelection = {
    model: {
      provider: 'openai-responses',
      serviceId,
      label: serviceId,
      categories: ['coding'],
    },
    mode: 'pinned-peer',
    peerId,
  };
  state.vprRoutableRows = [discoverRow(peerId, 'openai-responses', serviceId)];
  state.vprApplicationRoutes = {
    codex: { mode: 'client-model' },
    opencode: {
      mode: 'model',
      model: {
        provider: 'openai-responses',
        serviceId: 'qwen3-coder',
        label: 'Qwen3 Coder',
        categories: ['coding'],
      },
    },
    goose: { mode: 'follow-global' },
  };
  return state;
}

test('dedicated application route sync never starts or restarts connected apps', async () => {
  const state = routingState();
  let starts = 0;
  let posted: ApplicationRoutePolicies | null = null;
  const bridge: DesktopBridge = {
    systemProxyStart: async () => {
      starts += 1;
      return { ok: true };
    },
    systemProxySetApplicationRoutes: async (routes) => {
      posted = routes;
      return { ok: true };
    },
  };

  assert.deepEqual(await syncBuyerApplicationRoutes(bridge, state), { ok: true });
  assert.equal(starts, 0);
  assert.deepEqual(posted, {
    codex: { mode: 'client-model' },
    opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder' },
    goose: { mode: 'follow-global' },
  });
});

test('global route changes update the default without mutating Auto or explicit app policies', async () => {
  const state = routingState();
  const defaults: Array<{ peerId: string; service: string }> = [];
  const applicationUpdates: ApplicationRoutePolicies[] = [];
  let starts = 0;
  const bridge: DesktopBridge = {
    chatSetBuyerDefaultRoute: async (route) => {
      defaults.push(route);
      return { ok: true };
    },
    systemProxySetApplicationRoutes: async (routes) => {
      applicationUpdates.push(routes);
      return { ok: true };
    },
    systemProxyStart: async () => {
      starts += 1;
      return { ok: true };
    },
  };

  await applyVprRouteToConnectedProxy(bridge, state);
  state.vprRouteSelection = {
    model: {
      provider: 'openai-responses',
      serviceId: 'gpt-5.5',
      label: 'GPT-5.5',
      categories: ['coding'],
    },
    mode: 'pinned-peer',
    peerId: 'peer-b',
  };
  state.vprRoutableRows = [discoverRow('peer-b', 'openai-responses', 'gpt-5.5')];
  await applyVprRouteToConnectedProxy(bridge, state);

  assert.equal(starts, 0);
  assert.deepEqual(defaults, [
    { peerId: 'peer-a', service: 'gpt-5.4' },
    { peerId: 'peer-b', service: 'gpt-5.5' },
  ]);
  assert.deepEqual(applicationUpdates[0], applicationUpdates[1]);
  assert.deepEqual(applicationUpdates[1], {
    codex: { mode: 'client-model' },
    opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder' },
    goose: { mode: 'follow-global' },
  });
});

test('connecting an application posts restored policies through systemProxyStart', async () => {
  const state = routingState();
  let startOptions: Parameters<NonNullable<DesktopBridge['systemProxyStart']>>[0] | null = null;
  const bridge: DesktopBridge = {
    systemProxyGetState: async () => ({
      mode: 'system-proxy',
      running: true,
      activeProfileNames: ['codex'],
    }),
    systemProxyStart: async (options) => {
      startOptions = options;
      return { ok: true, state: { mode: 'system-proxy', running: true } };
    },
  };

  const result = await connectVprProfile(bridge, state, 'opencode');

  assert.equal(result.ok, true);
  assert.deepEqual(startOptions?.profiles, ['codex', 'opencode']);
  assert.equal(startOptions?.profileSwitch, true);
  assert.deepEqual(startOptions?.applicationRoutes, {
    codex: { mode: 'client-model' },
    opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder' },
    goose: { mode: 'follow-global' },
  });
});
