import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import type { ModelPickerEntry, ModelPickerSnapshot } from '../../shared/model-picker.js';
import {
  buildVprNativeMenuItems,
  selectVprNativeMenuModel,
  VPR_NATIVE_MODEL_LIMIT,
} from './vpr-native-menu.js';

function model(index: number): ModelPickerEntry {
  return {
    provider: `provider-${index}`,
    serviceId: `model-${index}`,
    label: `Model ${index}`,
    favorite: index < 2,
    routePeerId: `peer-${index}`,
    routeServiceId: `model-${index}`,
    routeProvider: `provider-${index}`,
  };
}

function invoke(item: MenuItemConstructorOptions | undefined): void {
  if (!item || typeof item.click !== 'function') {
    assert.fail('Expected a clickable native menu item');
  }
  (item.click as () => void)();
}

test('native VPR menu promotes the active model, deduplicates, and caps rows', () => {
  const models = Array.from({ length: 12 }, (_, index) => model(index));
  models.push({ ...models[3]! });
  const snapshot: ModelPickerSnapshot = {
    models,
    selected: { provider: 'provider-9', serviceId: 'model-9' },
  };
  const selections: string[] = [];
  const menu = buildVprNativeMenuItems(snapshot, {
    selectModel: (selection) => selections.push(selection.serviceId),
    browseModels: () => selections.push('browse'),
  });
  const radioItems = menu.filter((item) => item.type === 'radio');

  assert.equal(radioItems.length, VPR_NATIVE_MODEL_LIMIT);
  assert.equal(radioItems[0]?.label, 'Model 9');
  assert.equal(radioItems[0]?.checked, true);
  assert.equal(new Set(radioItems.map((item) => item.label)).size, VPR_NATIVE_MODEL_LIMIT);

  invoke(radioItems[1]);
  invoke(menu.find((item) => item.label === 'Manage Models…'));
  assert.deepEqual(selections, ['model-0', 'browse']);
});

test('native VPR menu updates its selected snapshot immediately', () => {
  const snapshot: ModelPickerSnapshot = {
    models: [model(0), model(1), model(2)],
    selected: { provider: 'provider-0', serviceId: 'model-0' },
  };
  const selected = selectVprNativeMenuModel(snapshot, {
    provider: 'provider-2',
    serviceId: 'model-2',
  });

  assert.equal(selected?.selected?.serviceId, 'model-2');
  assert.equal(selected?.models[0]?.serviceId, 'model-2');
});

test('native VPR menu shows no fallback model rows before catalog sync', () => {
  const menu = buildVprNativeMenuItems(null, {
    selectModel: () => {},
    browseModels: () => {},
  });

  assert.deepEqual(menu.map((item) => item.label ?? item.type), [
    'separator',
    'Manage Models…',
  ]);
});
