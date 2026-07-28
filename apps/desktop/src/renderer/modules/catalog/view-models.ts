import type { DiscoverRow, VprModelCatalogEntry, VprRouteSelection } from '../../core/state';
import { sameCanonicalModel } from './model-identity';
import { modelPinKey, type VprModelPins } from '../routing/model-pins';
import { shortPeerId } from '../routing/tools';

export type VprCatalogSort = 'Popular' | 'Price' | 'Savings' | 'Name';

export type VprCatalogFilterOptions = {
  search?: string;
  category?: string | null;
};

export type VprSelectedRouteModel = {
  provider?: string | null;
  serviceId?: string | null;
} | null | undefined;

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function catalogSearchText(entry: VprModelCatalogEntry): string {
  return [
    entry.label,
    entry.serviceId,
    entry.provider,
    ...entry.categories,
  ].join(' ').toLowerCase();
}

function entryMinTotalPrice(entry: VprModelCatalogEntry): number | null {
  if (entry.minInputUsdPerMillion === null || entry.minOutputUsdPerMillion === null) return null;
  return entry.minInputUsdPerMillion + entry.minOutputUsdPerMillion;
}

function compareNullableAscending(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareNullableDescending(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compareByName(a: VprModelCatalogEntry, b: VprModelCatalogEntry): number {
  return a.label.localeCompare(b.label)
    || a.provider.localeCompare(b.provider)
    || a.serviceId.localeCompare(b.serviceId);
}

export function filterVprCatalog(
  entries: VprModelCatalogEntry[],
  options: VprCatalogFilterOptions = {},
): VprModelCatalogEntry[] {
  const search = normalized(options.search ?? '');
  const category = normalized(options.category ?? '');

  return entries.filter((entry) => {
    if (category && !entry.categories.some((candidate) => normalized(candidate) === category)) {
      return false;
    }
    if (!search) return true;
    return catalogSearchText(entry).includes(search);
  });
}

export function sortVprCatalog(
  entries: VprModelCatalogEntry[],
  sort: VprCatalogSort = 'Popular',
): VprModelCatalogEntry[] {
  return [...entries].sort((a, b) => {
    switch (sort) {
      case 'Price':
        return compareNullableAscending(entryMinTotalPrice(a), entryMinTotalPrice(b))
          || compareByName(a, b);
      case 'Savings':
        return compareNullableDescending(a.expectedSavingsPct, b.expectedSavingsPct)
          || compareByName(a, b);
      case 'Name':
        return compareByName(a, b);
      case 'Popular':
      default:
        return b.peerCount - a.peerCount || compareByName(a, b);
    }
  });
}

export function routesForSelectedModel(
  rows: DiscoverRow[],
  selectedModel: VprSelectedRouteModel,
): DiscoverRow[] {
  const serviceId = selectedModel?.serviceId;
  if (!serviceId) return [];

  // Canonical match: sellers advertise the same model under near-identical
  // serviceIds and different provider strings — all of them are routes for
  // the selected model. Dispatch must carry the chosen row's own serviceId.
  return rows.filter((row) => sameCanonicalModel(row.serviceId, serviceId));
}

/** The seller a model is pinned to, so model lists can say which peer serves
 * it instead of only "N peers" — null while routing is on auto. Falls back to
 * a short peer id when the pinned seller is missing from the current discover
 * rows (offline, or filtered out by preferences). */
export function pinnedSellerLabel(
  rows: DiscoverRow[],
  selection: VprRouteSelection,
): string | null {
  if (selection.mode !== 'pinned-peer') return null;
  const peerId = selection.peerId;
  if (!peerId) return null;
  const route = routesForSelectedModel(rows, selection.model)
    .find((candidate) => candidate.peerId === peerId);
  return route?.peerDisplayName?.trim() || route?.peerLabel?.trim() || shortPeerId(peerId);
}

/**
 * Seller names for every listed model that remembers a pin, keyed the same way
 * model rows are (`provider:serviceId`). Pins whose seller no longer serves
 * the model are left out — a stale pin shouldn't claim a route that's gone.
 */
export function pinnedSellerLabels(
  rows: DiscoverRow[],
  pins: VprModelPins,
  entries: readonly { provider: string; serviceId: string }[],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    const key = modelPinKey(entry.provider, entry.serviceId);
    const peerId = pins[key];
    if (!peerId || labels.has(key)) continue;
    const route = routesForSelectedModel(rows, entry).find((candidate) => candidate.peerId === peerId);
    if (!route) continue;
    labels.set(key, route.peerDisplayName?.trim() || route.peerLabel?.trim() || shortPeerId(peerId));
  }
  return labels;
}
