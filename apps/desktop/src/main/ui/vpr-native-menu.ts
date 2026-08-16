import type { MenuItemConstructorOptions } from 'electron';
import type {
  ModelPickerEntry,
  ModelPickerSnapshot,
  ModelPickerSelection,
} from '../../shared/model-picker.js';

export const VPR_NATIVE_MODEL_LIMIT = 8;

export type VprNativeMenuActions = {
  selectModel: (selection: ModelPickerSelection) => void;
  browseModels: () => void;
};

function modelKey(model: Pick<ModelPickerEntry, 'provider' | 'serviceId'>): string {
  return `${model.provider}\u0000${model.serviceId}`;
}

function quickModels(snapshot: ModelPickerSnapshot): ModelPickerEntry[] {
  const selectedKey = snapshot.selected ? modelKey(snapshot.selected) : null;
  const seen = new Set<string>();
  const models: ModelPickerEntry[] = [];
  const add = (model: ModelPickerEntry): void => {
    const key = modelKey(model);
    if (seen.has(key)) return;
    seen.add(key);
    models.push(model);
  };

  if (selectedKey) {
    const selected = snapshot.models.find((model) => modelKey(model) === selectedKey);
    if (selected) add(selected);
  }
  for (const model of snapshot.models) add(model);
  return models.slice(0, VPR_NATIVE_MODEL_LIMIT);
}

export function selectVprNativeMenuModel(
  snapshot: ModelPickerSnapshot | null,
  selection: ModelPickerSelection,
): ModelPickerSnapshot | null {
  if (!snapshot) return null;
  const selected = snapshot.models.find((model) => modelKey(model) === modelKey(selection));
  if (!selected) return snapshot;
  return {
    models: [selected, ...snapshot.models.filter((model) => model !== selected)],
    selected: selection,
  };
}

export function buildVprNativeMenuItems(
  snapshot: ModelPickerSnapshot | null,
  actions: VprNativeMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ type: 'separator' }];
  if (snapshot?.models.length) {
    const selectedKey = snapshot.selected ? modelKey(snapshot.selected) : null;
    items.push(
      { label: 'Models', enabled: false },
      ...quickModels(snapshot).map((model) => ({
        type: 'radio' as const,
        label: model.label,
        checked: modelKey(model) === selectedKey,
        click: () => actions.selectModel({
          provider: model.provider,
          serviceId: model.serviceId,
        }),
      })),
      { type: 'separator' },
    );
  }
  items.push({ label: 'Manage Models…', click: actions.browseModels });
  return items;
}
