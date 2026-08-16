import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelPickerSnapshot } from './model-picker.js';
import {
  buildVprMenuBarState,
  normalizeVprMenuBarAction,
  VPR_MENU_BAR_MODEL_LIMIT,
} from './vpr-menu-bar.js';

function snapshot(count: number, selectedIndex: number | null): ModelPickerSnapshot {
  const models = Array.from({ length: count }, (_, index) => ({
    provider: `provider-${index}`,
    serviceId: `model-${index}`,
    label: `Model ${index}`,
    favorite: index < 2,
    routePeerId: `peer-${index}`,
    routeServiceId: `model-${index}`,
    routeProvider: `provider-${index}`,
  }));
  return {
    models,
    selected: selectedIndex === null
      ? null
      : { provider: `provider-${selectedIndex}`, serviceId: `model-${selectedIndex}` },
  };
}

test('menu-bar state moves the active model first and caps the quick list', () => {
  const state = buildVprMenuBarState(snapshot(12, 9));
  assert.equal(state.models.length, VPR_MENU_BAR_MODEL_LIMIT);
  assert.equal(state.models[0]?.serviceId, 'model-9');
  assert.equal(state.selectedModel?.serviceId, 'model-9');
});

test('menu-bar state deduplicates model entries', () => {
  const input = snapshot(3, 1);
  input.models.push({ ...input.models[1]! });
  const state = buildVprMenuBarState(input);
  assert.deepEqual(state.models.map((entry) => entry.serviceId), ['model-1', 'model-0', 'model-2']);
});

test('menu-bar action normalizer accepts only supported actions', () => {
  assert.deepEqual(normalizeVprMenuBarAction({ type: 'browse-models' }), { type: 'browse-models' });
  assert.deepEqual(normalizeVprMenuBarAction({ type: 'open-main' }), { type: 'open-main' });
  assert.deepEqual(
    normalizeVprMenuBarAction({ type: 'open-floating-window' }),
    { type: 'open-floating-window' },
  );
  assert.deepEqual(normalizeVprMenuBarAction({ type: 'dismiss' }), { type: 'dismiss' });
  assert.deepEqual(
    normalizeVprMenuBarAction({ type: 'select-model', provider: 'openai', serviceId: 'gpt' }),
    { type: 'select-model', provider: 'openai', serviceId: 'gpt' },
  );
  assert.equal(normalizeVprMenuBarAction({ type: 'select-model', provider: '', serviceId: 'gpt' }), null);
});
