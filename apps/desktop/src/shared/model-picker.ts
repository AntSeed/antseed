/**
 * Model-picker snapshot the renderer pushes to the main process so
 * non-renderer frontends (the Telegram bridge) can offer the exact same
 * curated model list as the in-app dropdown and the float pill: starred
 * favorites first, then the recommended lineup, current selection always
 * present. The renderer owns the curation (favorites live in localStorage,
 * routing preferences and per-model pins in its UI state); main only caches
 * the latest snapshot.
 */

export type ModelPickerEntry = {
  provider: string;
  serviceId: string;
  /** Human display label ("Claude Fable 5"), same as the dropdown rows. */
  label: string;
  /** Starred on the model pages — rendered with a star, listed first. */
  favorite: boolean;
  /** Seller the app would route this model to right now (per-model pin when
   *  set and still valid, else the routing-preferences best route). Null when
   *  no routable seller serves the model — such entries are not offerable. */
  routePeerId: string | null;
  /** The route seller's own advertised serviceId/provider for this model —
   *  catalog entries aggregate canonical variants, and dispatch must carry
   *  the pair the pinned peer actually serves. */
  routeServiceId: string | null;
  routeProvider: string | null;
};

export type ModelPickerSnapshot = {
  /** Display order: favorites first, then recommended. */
  models: ModelPickerEntry[];
  /** The app's current model selection, for the ✓ mark. */
  selected: { provider: string; serviceId: string } | null;
};

export function normalizeModelPickerSnapshot(raw: unknown): ModelPickerSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as Record<string, unknown>;
  if (!Array.isArray(snapshot.models)) return null;
  const models: ModelPickerEntry[] = [];
  for (const item of snapshot.models) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.provider !== 'string' || typeof entry.serviceId !== 'string') continue;
    if (entry.serviceId.trim().length === 0) continue;
    const asId = (value: unknown): string | null => (
      typeof value === 'string' && value.trim().length > 0 ? value : null
    );
    models.push({
      provider: entry.provider,
      serviceId: entry.serviceId,
      label: asId(entry.label) ?? entry.serviceId,
      favorite: entry.favorite === true,
      routePeerId: asId(entry.routePeerId),
      routeServiceId: asId(entry.routeServiceId),
      routeProvider: asId(entry.routeProvider),
    });
  }
  const selectedRaw = snapshot.selected as Record<string, unknown> | null | undefined;
  const selected = selectedRaw && typeof selectedRaw === 'object'
    && typeof selectedRaw.provider === 'string' && typeof selectedRaw.serviceId === 'string'
    ? { provider: selectedRaw.provider, serviceId: selectedRaw.serviceId }
    : null;
  return { models, selected };
}
