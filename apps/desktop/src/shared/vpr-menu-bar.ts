import type { ModelPickerEntry, ModelPickerSnapshot } from './model-picker.js';

export const VPR_MENU_BAR_MODEL_LIMIT = 8;

export type VprMenuBarModel = Pick<ModelPickerEntry, 'provider' | 'serviceId' | 'label'>;

export type VprMenuBarState = {
  models: VprMenuBarModel[];
  selectedModel: VprMenuBarModel | null;
};

export type VprMenuBarAction =
  | { type: 'select-model'; provider: string; serviceId: string }
  | { type: 'browse-models' }
  | { type: 'open-main' }
  | { type: 'open-floating-window' }
  | { type: 'dismiss' };

function modelKey(model: Pick<ModelPickerEntry, 'provider' | 'serviceId'>): string {
  return `${model.provider}\u0000${model.serviceId}`;
}

export function buildVprMenuBarState(snapshot: ModelPickerSnapshot): VprMenuBarState {
  const selectedKey = snapshot.selected ? modelKey(snapshot.selected) : null;
  const seen = new Set<string>();
  const models: VprMenuBarModel[] = [];

  const add = (entry: ModelPickerEntry): void => {
    const key = modelKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    models.push({ provider: entry.provider, serviceId: entry.serviceId, label: entry.label });
  };

  if (selectedKey) {
    const selected = snapshot.models.find((entry) => modelKey(entry) === selectedKey);
    if (selected) add(selected);
  }
  for (const entry of snapshot.models) add(entry);

  const limited = models.slice(0, VPR_MENU_BAR_MODEL_LIMIT);
  return {
    models: limited,
    selectedModel: selectedKey
      ? limited.find((entry) => modelKey(entry) === selectedKey) ?? null
      : null,
  };
}

export function normalizeVprMenuBarAction(raw: unknown): VprMenuBarAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = raw as Record<string, unknown>;
  if (
    action.type === 'browse-models'
    || action.type === 'open-main'
    || action.type === 'open-floating-window'
    || action.type === 'dismiss'
  ) {
    return { type: action.type };
  }
  if (
    action.type === 'select-model'
    && typeof action.provider === 'string'
    && typeof action.serviceId === 'string'
    && action.provider.trim().length > 0
    && action.serviceId.trim().length > 0
  ) {
    return {
      type: 'select-model',
      provider: action.provider,
      serviceId: action.serviceId,
    };
  }
  return null;
}
