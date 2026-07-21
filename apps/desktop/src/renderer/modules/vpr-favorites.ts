/** Starred models on the model page, persisted per install (localStorage). */

export const VPR_FAVORITES_STORAGE_KEY = 'antseed.desktop.vpr.favoriteModels';

export function favoriteModelKey(provider: string, serviceId: string): string {
  return `${provider}:${serviceId}`;
}

export function loadFavoriteModels(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(VPR_FAVORITES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'));
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
  return favorites;
}
