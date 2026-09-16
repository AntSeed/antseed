import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  clearVprModelPin,
  clearVprPinsForPeer,
  filterVprModelPins,
  modelPinKey,
  loadVprModelPins,
  setVprModelPin,
  vprModelPinFor,
} from './model-pins.js';
import { withAutoRouterCatalogEntry } from './auto-router.js';
import type { RouterPluginInfo } from '../../types/bridge.js';

/**
 * `isAutoRouterEntry` (which `setVprModelPin`/`vprModelPinFor` guard against)
 * only recognizes an entry once a real router plugin has actually been
 * resolved, so these two tests seed one explicitly instead of relying on a
 * default. Just a fixture value, not sourced from production code.
 */
const AUTO_ROUTER_SENTINEL_SERVICE_ID = 'levanto-auto';
const LEVANTO_LIKE_ROUTER: RouterPluginInfo = {
  package: '@antseed/router-levanto',
  version: '0.0.1',
  name: 'levanto',
  displayName: 'Levanto Router',
  description: 'test fixture',
  autoRouteServiceId: AUTO_ROUTER_SENTINEL_SERVICE_ID,
};
withAutoRouterCatalogEntry(
  [],
  { selectedRouterPackage: LEVANTO_LIKE_ROUTER.package },
  [LEVANTO_LIKE_ROUTER],
);

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

test('a pin is stored and read back per model', () => {
  const pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  assert.deepEqual(pins, { [modelPinKey('openai', 'gpt-test')]: 'peer-1' });
  assert.equal(vprModelPinFor(pins, 'openai', 'gpt-test'), 'peer-1');
  assert.equal(vprModelPinFor(pins, 'openai', 'other-model'), null);
});

test('pinning one model leaves other models pinned', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-2');
  assert.equal(vprModelPinFor(pins, 'openai', 'gpt-test'), 'peer-1');
  assert.equal(vprModelPinFor(pins, 'anthropic', 'fable-5'), 'peer-2');
});

test('clearing one model does not touch the others', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-2');
  pins = clearVprModelPin(pins, 'openai', 'gpt-test');
  assert.equal(vprModelPinFor(pins, 'openai', 'gpt-test'), null);
  assert.equal(vprModelPinFor(pins, 'anthropic', 'fable-5'), 'peer-2');
});

test('blocking a peer drops every model pinned to it', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-1');
  pins = setVprModelPin(pins, 'openai', 'gpt-other', 'peer-2');
  pins = clearVprPinsForPeer(pins, 'peer-1');
  assert.deepEqual(pins, { [modelPinKey('openai', 'gpt-other')]: 'peer-2' });
});

test('canonical service variants share the same pin', () => {
  const pins = setVprModelPin({}, 'openai', 'openai/gpt-test-latest', 'peer-1');
  assert.equal(vprModelPinFor(pins, 'other-provider', 'gpt-test'), 'peer-1');
});

test('filtering pins removes every peer rejected by the current rules', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-2');
  assert.deepEqual(filterVprModelPins(pins, (peerId) => peerId === 'peer-2'), {
    [modelPinKey('anthropic', 'fable-5')]: 'peer-2',
  });
});

test('blank peer ids are not stored', () => {
  assert.deepEqual(setVprModelPin({}, 'openai', 'gpt-test', '   '), {});
});

test('refuses to pin the Auto sentinel to a peer -- it must always be chosen per-request, never stranded on one seller', () => {
  const pins = setVprModelPin({}, 'levanto', AUTO_ROUTER_SENTINEL_SERVICE_ID, 'peer-1');
  assert.deepEqual(pins, {});
  assert.equal(vprModelPinFor(pins, 'levanto', AUTO_ROUTER_SENTINEL_SERVICE_ID), null);
});

test('ignores an already-corrupted Auto sentinel pin from a pre-fix build instead of requiring a manual localStorage edit', () => {
  const corrupted = { [modelPinKey('levanto', AUTO_ROUTER_SENTINEL_SERVICE_ID)]: 'peer-1' };
  assert.equal(vprModelPinFor(corrupted, 'levanto', AUTO_ROUTER_SENTINEL_SERVICE_ID), null);
});

test('loads pins persisted with legacy canonical model keys', () => {
  storage.set('antseed.desktop.vpr.modelPins', JSON.stringify({
    claudefable5: 'peer-1',
    'gpt5.6sol': 'peer-2',
    'glm5.2': 'peer-3',
  }));

  assert.deepEqual(loadVprModelPins(), {
    fable5: 'peer-1',
    gpt56sol: 'peer-2',
    glm52: 'peer-3',
  });
  storage.clear();
});
