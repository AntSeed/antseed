import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry, VprRoutingPreferences } from '../../core/state';
import type { RouterPluginInfo } from '../../types/bridge';
import {
  isAutoRouterEntry,
  isAutoRouterSelected,
  withAutoRouterCatalogEntry,
} from './auto-router.js';

function realEntry(overrides: Partial<VprModelCatalogEntry> = {}): VprModelCatalogEntry {
  return {
    provider: 'openai',
    serviceId: 'gpt-5.6-luna',
    label: 'GPT 5.6 Luna',
    peerCount: 3,
    categories: [],
    kind: 'text',
    protocols: [],
    minInputUsdPerMillion: 0.2,
    maxInputUsdPerMillion: 0.3,
    minOutputUsdPerMillion: 1.1,
    maxOutputUsdPerMillion: 1.2,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    hasEligibleFreeSeller: false,
    bestPeerId: '0xAAA',
    ...overrides,
  };
}

type AutoPreferences = Pick<VprRoutingPreferences, 'routerEnabled' | 'selectedRouterPackage'>;

const ENABLED_DEFAULT: AutoPreferences = { routerEnabled: true, selectedRouterPackage: null };
const DISABLED: AutoPreferences = { routerEnabled: false, selectedRouterPackage: null };

const CUSTOM_ROUTER: RouterPluginInfo = {
  package: '@antseed/router-custom',
  version: '1.0.0',
  name: 'custom',
  displayName: 'Custom Router',
  description: 'A different router plugin',
  autoRouteServiceId: 'custom-auto',
};

test('a model router can be enabled without day-pass consent', () => {
  const catalog = withAutoRouterCatalogEntry([], {
    routerEnabled: true, selectedRouterPackage: CUSTOM_ROUTER.package,
  }, [CUSTOM_ROUTER]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.serviceId, CUSTOM_ROUTER.autoRouteServiceId);
});

test('explicit router disable overrides legacy day-pass consent', () => {
  assert.deepEqual(withAutoRouterCatalogEntry([], {
    routerEnabled: false, selectedRouterPackage: CUSTOM_ROUTER.package,
  }, [CUSTOM_ROUTER]), []);
});

test('withAutoRouterCatalogEntry shows no Auto entry when no router plugin is actually installed, even with the toggle on', () => {
  // A deployment with zero router plugins installed must never show a
  // pickable "Auto" entry that can't actually route through anything --
  // see resolveActiveAutoRouterPlugin's own doc comment for why a router's
  // identity is always sourced from its own declared metadata rather than
  // assumed.
  const catalog = withAutoRouterCatalogEntry([realEntry()], ENABLED_DEFAULT, []);
  assert.equal(catalog.length, 1);
  assert.equal(catalog.some(isAutoRouterEntry), false);
});

test('withAutoRouterCatalogEntry uses the selected plugin\'s own declared identity when installed', () => {
  const preferences: AutoPreferences = { routerEnabled: true, selectedRouterPackage: CUSTOM_ROUTER.package };
  const catalog = withAutoRouterCatalogEntry([realEntry()], preferences, [CUSTOM_ROUTER]);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0]!.provider, 'custom');
  assert.equal(catalog[0]!.serviceId, 'custom-auto');
  assert.equal(catalog[0]!.label, 'Custom Router');
});

test('withAutoRouterCatalogEntry is idempotent -- never duplicates the entry on repeated calls', () => {
  const preferences: AutoPreferences = { routerEnabled: true, selectedRouterPackage: CUSTOM_ROUTER.package };
  const once = withAutoRouterCatalogEntry([realEntry()], preferences, [CUSTOM_ROUTER]);
  const twice = withAutoRouterCatalogEntry(once, preferences, [CUSTOM_ROUTER]);
  assert.equal(twice.filter(isAutoRouterEntry).length, 1);
});

test('withAutoRouterCatalogEntry works on an empty catalog (no discovered sellers yet)', () => {
  const preferences: AutoPreferences = { routerEnabled: true, selectedRouterPackage: CUSTOM_ROUTER.package };
  const catalog = withAutoRouterCatalogEntry([], preferences, [CUSTOM_ROUTER]);
  assert.equal(catalog.length, 1);
  assert.ok(isAutoRouterEntry(catalog[0]!));
});

test('withAutoRouterCatalogEntry omits the Auto entry when disabled', () => {
  const catalog = withAutoRouterCatalogEntry([realEntry()], DISABLED, []);
  assert.equal(catalog.length, 1);
  assert.equal(catalog.some(isAutoRouterEntry), false);
});

test('withAutoRouterCatalogEntry drops a stale Auto entry when disabled, even if the catalog already had one', () => {
  const withEntry = withAutoRouterCatalogEntry([realEntry()], ENABLED_DEFAULT, []);
  const afterToggleOff = withAutoRouterCatalogEntry(withEntry, DISABLED, []);
  assert.equal(afterToggleOff.length, 1);
  assert.equal(afterToggleOff.some(isAutoRouterEntry), false);
});

test('withAutoRouterCatalogEntry on an empty catalog when disabled stays empty', () => {
  const catalog = withAutoRouterCatalogEntry([], DISABLED, []);
  assert.equal(catalog.length, 0);
});

test('isAutoRouterEntry rejects a real model entry', () => {
  withAutoRouterCatalogEntry([], ENABLED_DEFAULT, []);
  assert.equal(isAutoRouterEntry(realEntry()), false);
});

test('isAutoRouterSelected is false when no model is selected (null)', () => {
  assert.equal(isAutoRouterSelected(null), false);
});

test('isAutoRouterSelected is false for a real, concretely-selected model', () => {
  withAutoRouterCatalogEntry([], ENABLED_DEFAULT, []);
  assert.equal(isAutoRouterSelected(realEntry()), false);
});

test('isAutoRouterSelected is true when the currently-active Auto entry is the selected model', () => {
  const preferences: AutoPreferences = { routerEnabled: true, selectedRouterPackage: CUSTOM_ROUTER.package };
  const catalog = withAutoRouterCatalogEntry([], preferences, [CUSTOM_ROUTER]);
  assert.equal(isAutoRouterSelected(catalog[0]!), true);
});
