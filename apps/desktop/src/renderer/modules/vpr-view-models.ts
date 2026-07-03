import type { DiscoverRow, VprModelCatalogEntry } from '../core/state';

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
  const provider = selectedModel?.provider;
  const serviceId = selectedModel?.serviceId;
  if (!provider || !serviceId) return [];

  return rows.filter((row) => row.provider === provider && row.serviceId === serviceId);
}
