import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';

import type { VprRoutingPreferences, VprRouteSelection } from '../core/state';
import {
  loadVprRouteSelection,
  loadVprRoutingPreferences,
  saveVprRouteSelection,
  saveVprRoutingPreferences,
  VPR_PREFERENCES_STORAGE_KEY,
  VPR_ROUTE_SELECTION_STORAGE_KEY,
} from './vpr-preferences.js';

const fallbackPreferences: VprRoutingPreferences = {
  autoRouting: true,
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 0,
};

const fallbackRouteSelection: VprRouteSelection = {
  model: null,
  mode: 'auto',
  peerId: null,
};

function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
}

beforeEach(() => {
  installLocalStorage();
});

test('malformed preference JSON falls back', () => {
  localStorage.setItem(VPR_PREFERENCES_STORAGE_KEY, '{bad json');

  assert.deepEqual(loadVprRoutingPreferences(fallbackPreferences), fallbackPreferences);
});

test('valid VPR preferences and route selection save and load', () => {
  const preferences: VprRoutingPreferences = {
    autoRouting: false,
    preferFreePeers: true,
    maxInputUsdPerMillion: 3.5,
    minTrustScore: 62,
  };
  const routeSelection: VprRouteSelection = {
    model: {
      provider: 'openai',
      serviceId: 'gpt-5',
      label: 'GPT-5',
      categories: ['reasoning', 'coding'],
    },
    mode: 'pinned-peer',
    peerId: 'peer-1',
  };

  saveVprRoutingPreferences(preferences);
  saveVprRouteSelection(routeSelection);

  assert.deepEqual(loadVprRoutingPreferences(fallbackPreferences), preferences);
  assert.deepEqual(loadVprRouteSelection(fallbackRouteSelection), routeSelection);
});

test('invalid route mode falls back', () => {
  localStorage.setItem(
    VPR_ROUTE_SELECTION_STORAGE_KEY,
    JSON.stringify({
      model: null,
      mode: 'manual',
      peerId: 'peer-1',
    }),
  );

  assert.deepEqual(loadVprRouteSelection(fallbackRouteSelection), fallbackRouteSelection);
});
