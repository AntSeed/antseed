import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';

import type { VprRoutingPreferences, VprRouteSelection } from '../../core/state';
import {
  applyPeerListing,
  buyerModelRoutingPreferences,
  loadVprRouteSelection,
  loadVprRoutingPreferences,
  peerListingOf,
  saveVprRouteSelection,
  saveVprRoutingPreferences,
  VPR_PREFERENCES_STORAGE_KEY,
  VPR_ROUTE_SELECTION_STORAGE_KEY,
} from './preferences.js';

const fallbackPreferences: VprRoutingPreferences = {
  autoRouting: true,
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
  cqt: 5,
  dayPassOnDemandEnabled: false,
};

test('legacy activation migrates without granting new day-pass consent', () => {
  for (const consent of [true, false]) {
    localStorage.setItem(VPR_PREFERENCES_STORAGE_KEY, JSON.stringify({ dayPassOnDemandEnabled: consent, autoRouting: false }));
    const loaded = loadVprRoutingPreferences(fallbackPreferences);
    assert.equal(loaded.routerEnabled, consent);
    assert.equal(loaded.dayPassOnDemandEnabled, consent);
    assert.equal(loaded.autoRouting, false);
  }
  localStorage.setItem(VPR_PREFERENCES_STORAGE_KEY, JSON.stringify({ routerEnabled: true }));
  const loaded = loadVprRoutingPreferences(fallbackPreferences);
  assert.equal(loaded.routerEnabled, true);
  assert.equal(loaded.dayPassOnDemandEnabled, false);
});

test('migrates the previous zero default to the new 6.0 minimum', () => {
  localStorage.setItem(
    VPR_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ ...fallbackPreferences, minTrustScore: 0 }),
  );

  assert.equal(loadVprRoutingPreferences(fallbackPreferences).minTrustScore, 60);
});

test('preserves an explicitly saved zero minimum in the current format', () => {
  saveVprRoutingPreferences({ ...fallbackPreferences, minTrustScore: 0 });
  assert.equal(loadVprRoutingPreferences(fallbackPreferences).minTrustScore, 0);
});

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
    allowedPeerIds: ['peer-1'],
    blockedPeerIds: ['peer-2', 'peer-3'],
    cqt: 7,
    dayPassOnDemandEnabled: true,
    selectedRouterPackage: '@antseed/router-custom',
    agreedDayPassPricesUsdc: { cccccccccccccccccccccccccccccccccccccccc: 0.89 },
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

  assert.deepEqual(loadVprRoutingPreferences(fallbackPreferences), { ...preferences, routerEnabled: true });
  assert.deepEqual(loadVprRouteSelection(fallbackRouteSelection), routeSelection);
});

test('agreedDayPassPricesUsdc drops malformed entries instead of the whole map', () => {
  localStorage.setItem(VPR_PREFERENCES_STORAGE_KEY, JSON.stringify({
    ...fallbackPreferences,
    agreedDayPassPricesUsdc: {
      cccccccccccccccccccccccccccccccccccccccc: 0.89,
      dddddddddddddddddddddddddddddddddddddddd: 'not-a-number',
      eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: -1,
    },
  }));

  assert.deepEqual(
    loadVprRoutingPreferences(fallbackPreferences).agreedDayPassPricesUsdc,
    { cccccccccccccccccccccccccccccccccccccccc: 0.89 },
  );
});

test('agreedDayPassPricesUsdc falls back to the fallback map when nothing is stored', () => {
  const fallbackWithAgreedPrice: VprRoutingPreferences = {
    ...fallbackPreferences,
    agreedDayPassPricesUsdc: { cccccccccccccccccccccccccccccccccccccccc: 1.2 },
  };
  assert.deepEqual(
    loadVprRoutingPreferences(fallbackWithAgreedPrice).agreedDayPassPricesUsdc,
    { cccccccccccccccccccccccccccccccccccccccc: 1.2 },
  );
});

test('buyer config projection includes every field an installed router plugin\'s payment gate reads', () => {
  assert.deepEqual(buyerModelRoutingPreferences(fallbackPreferences), {
    preferFreePeers: fallbackPreferences.preferFreePeers,
    maxInputUsdPerMillion: fallbackPreferences.maxInputUsdPerMillion,
    minTrustScore: fallbackPreferences.minTrustScore,
    allowedPeerIds: fallbackPreferences.allowedPeerIds,
    blockedPeerIds: fallbackPreferences.blockedPeerIds,
    cqt: fallbackPreferences.cqt,
    dayPassOnDemandEnabled: fallbackPreferences.dayPassOnDemandEnabled,
    routerEnabled: false,
    selectedRouterPackage: null,
    autoRouting: fallbackPreferences.autoRouting,
    agreedDayPassPricesUsdc: {},
  });
});

test('buyer config projection forwards autoRouting -- an installed router\'s real-money signing can gate on this too', () => {
  // Regression: a buyer trying to stop day-pass billing reasonably
  // reached for the "Auto select seller" switch instead of the separate
  // control that owns dayPassOnDemandEnabled, and billing kept running
  // because this field used to be dropped from the projection entirely.
  const projected = buyerModelRoutingPreferences({ ...fallbackPreferences, autoRouting: false });
  assert.equal(projected.autoRouting, false);
});

test('buyer config projection forwards which router plugin is selected -- process-manager.ts reads this back to decide which router to start', () => {
  const projected = buyerModelRoutingPreferences({
    ...fallbackPreferences,
    dayPassOnDemandEnabled: true,
    selectedRouterPackage: '@antseed/router-custom',
  });
  assert.equal(projected.selectedRouterPackage, '@antseed/router-custom');
});

test('selectedRouterPackage stays unselected when absent from stored preferences, regardless of dayPassOnDemandEnabled', () => {
  for (const dayPassOnDemandEnabled of [true, false]) {
    localStorage.setItem(
      VPR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...fallbackPreferences, dayPassOnDemandEnabled }),
    );
    assert.equal(loadVprRoutingPreferences(fallbackPreferences).selectedRouterPackage, null);
  }
});

test('an explicit "None" (selectedRouterPackage: null) stays unselected regardless of dayPassOnDemandEnabled', () => {
  for (const dayPassOnDemandEnabled of [true, false]) {
    localStorage.setItem(
      VPR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...fallbackPreferences, dayPassOnDemandEnabled, selectedRouterPackage: null }),
    );
    assert.equal(loadVprRoutingPreferences(fallbackPreferences).selectedRouterPackage, null);
  }
});

test('buyer config projection forwards the day-pass-enable toggle -- real money gate, must not drop silently', () => {
  const projected = buyerModelRoutingPreferences({ ...fallbackPreferences, dayPassOnDemandEnabled: true });
  assert.equal(projected.dayPassOnDemandEnabled, true);
});

test('cqt dial value round-trips through save/load', () => {
  saveVprRoutingPreferences({ ...fallbackPreferences, cqt: 9 });
  assert.equal(loadVprRoutingPreferences(fallbackPreferences).cqt, 9);
});

test('an invalid stored cqt value falls back to the default rather than an off-scale number', () => {
  localStorage.setItem(
    VPR_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ ...fallbackPreferences, cqt: 4 }), // not one of {1,3,5,7,9}
  );
  assert.equal(loadVprRoutingPreferences(fallbackPreferences).cqt, fallbackPreferences.cqt);
});

test('buyer config projection forwards the cqt dial value', () => {
  const projected = buyerModelRoutingPreferences({ ...fallbackPreferences, cqt: 3 });
  assert.equal(projected.cqt, 3);
});

test('buyer config projection drops malformed peer ids before writing config', () => {
  const peerId = 'a'.repeat(40);
  const projected = buyerModelRoutingPreferences({
    ...fallbackPreferences,
    allowedPeerIds: ['not-a-peer', `0x${peerId}`],
  });

  assert.deepEqual(projected.allowedPeerIds, [`0x${peerId}`]);
});

test('peer lists from older stored preferences fall back to empty', () => {
  localStorage.setItem(
    VPR_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ autoRouting: false, preferFreePeers: true, maxInputUsdPerMillion: 4, minTrustScore: 10 }),
  );

  const loaded = loadVprRoutingPreferences(fallbackPreferences);
  assert.deepEqual(loaded.allowedPeerIds, []);
  assert.deepEqual(loaded.blockedPeerIds, []);
});

test('stored peer lists are trimmed, de-duplicated and blank-free', () => {
  localStorage.setItem(
    VPR_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ ...fallbackPreferences, blockedPeerIds: [' peer-1 ', 'peer-1', '', 7, 'peer-2'] }),
  );

  assert.deepEqual(loadVprRoutingPreferences(fallbackPreferences).blockedPeerIds, ['peer-1', 'peer-2']);
});

test('applyPeerListing moves a peer between lists and off them', () => {
  const allowed = applyPeerListing(fallbackPreferences, 'peer-1', 'allowed');
  assert.deepEqual(allowed.allowedPeerIds, ['peer-1']);
  assert.equal(peerListingOf(allowed, 'peer-1'), 'allowed');

  const blocked = applyPeerListing(allowed, 'peer-1', 'blocked');
  assert.deepEqual(blocked.allowedPeerIds, []);
  assert.deepEqual(blocked.blockedPeerIds, ['peer-1']);
  assert.equal(peerListingOf(blocked, 'peer-1'), 'blocked');

  const cleared = applyPeerListing(blocked, 'peer-1', 'none');
  assert.deepEqual(cleared.blockedPeerIds, []);
  assert.equal(peerListingOf(cleared, 'peer-1'), 'none');
});

test('applyPeerListing ignores blank peer ids', () => {
  assert.equal(applyPeerListing(fallbackPreferences, '   ', 'blocked'), fallbackPreferences);
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
