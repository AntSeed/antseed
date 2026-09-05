/** Starred models on the model page, persisted per install (localStorage). */

import { canonicalModelKey, canonicalPersistedModelKey } from './model-identity';

export const VPR_FAVORITES_STORAGE_KEY = 'antseed.desktop.vpr.favoriteModels';

/** Fired on window after a star toggle so listeners outside React (the
 *  main-process model-picker sync) can react without polling localStorage. */
export const VPR_FAVORITES_CHANGED_EVENT = 'antseed:vpr-favorites-changed';

/** Canonical so a star sticks to the model, not to one seller's serviceId
 *  variant (catalog entries aggregate variants). Provider is a tiebreaker
 *  only for ids that don't canonicalize. */
export function favoriteModelKey(provider: string, serviceId: string): string {
  return canonicalModelKey(serviceId) || `${provider}:${serviceId}`;
}

export function loadFavoriteModels(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(VPR_FAVORITES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    const favorites = new Set<string>();
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const key = canonicalPersistedModelKey(entry);
      if (key) favorites.add(key);
    }
    return favorites;
  } catch {
    return new Set();
  }
}

export function toggleFavoriteModel(provider: string, serviceId: string): Set<string> {
  const favorites = loadFavoriteModels();
  const key = favoriteModelKey(provider, serviceId);
  if (favorites.has(key)) {
    favorites.delete(key);
  } else {
    favorites.add(key);
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(VPR_FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(VPR_FAVORITES_CHANGED_EVENT));
  }
  return favorites;
}
