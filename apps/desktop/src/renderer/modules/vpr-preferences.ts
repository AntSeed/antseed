import type { VprRoutingPreferences, VprRouteSelection } from '../core/state';

export const VPR_PREFERENCES_STORAGE_KEY = 'antseed.desktop.vpr.preferences';
export const VPR_ROUTE_SELECTION_STORAGE_KEY = 'antseed.desktop.vpr.routeSelection';

type StoredObject = Record<string, unknown>;

function isStoredObject(value: unknown): value is StoredObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function loadJson(storageKey: string): unknown {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  const raw = localStorage.getItem(storageKey);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNonNegativeFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function loadRouteModel(value: unknown): VprRouteSelection['model'] {
  if (value === null) {
    return null;
  }
  if (!isStoredObject(value)) {
    return null;
  }
  if (
    typeof value.provider !== 'string' ||
    typeof value.serviceId !== 'string' ||
    typeof value.label !== 'string'
  ) {
    return null;
  }

  return {
    provider: value.provider,
    serviceId: value.serviceId,
    label: value.label,
    categories: isStringArray(value.categories) ? value.categories : [],
  };
}

export function loadVprRoutingPreferences(fallback: VprRoutingPreferences): VprRoutingPreferences {
  const parsed = loadJson(VPR_PREFERENCES_STORAGE_KEY);
  if (!isStoredObject(parsed)) {
    return fallback;
  }

  return {
    autoRouting: readBoolean(parsed.autoRouting, fallback.autoRouting),
    preferFreePeers: readBoolean(parsed.preferFreePeers, fallback.preferFreePeers),
    maxInputUsdPerMillion: readNonNegativeFiniteNumber(
      parsed.maxInputUsdPerMillion,
      fallback.maxInputUsdPerMillion,
    ),
    minTrustScore: readNonNegativeFiniteNumber(parsed.minTrustScore, fallback.minTrustScore),
  };
}

export function saveVprRoutingPreferences(value: VprRoutingPreferences): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.setItem(VPR_PREFERENCES_STORAGE_KEY, JSON.stringify(value));
}

export function loadVprRouteSelection(fallback: VprRouteSelection): VprRouteSelection {
  const parsed = loadJson(VPR_ROUTE_SELECTION_STORAGE_KEY);
  if (!isStoredObject(parsed)) {
    return fallback;
  }
  if (parsed.mode !== 'auto' && parsed.mode !== 'pinned-peer') {
    return fallback;
  }

  return {
    model: loadRouteModel(parsed.model),
    mode: parsed.mode,
    peerId: typeof parsed.peerId === 'string' || parsed.peerId === null ? parsed.peerId : fallback.peerId,
  };
}

export function saveVprRouteSelection(value: VprRouteSelection): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.setItem(VPR_ROUTE_SELECTION_STORAGE_KEY, JSON.stringify(value));
}
