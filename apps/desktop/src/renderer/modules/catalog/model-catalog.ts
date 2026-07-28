import type { DiscoverRow, VprModelCatalogEntry, VprSelectedModel } from '../../core/state';
import { canonicalModelKey, displayModelLabel, sameCanonicalModel } from './model-identity';
import { isFreeCatalogEntry, selectRecommendedVprCatalog } from './recommended';

const VPR_MODEL_CATALOG_SEPARATOR = '\u0001';

type ModelCatalogGroup = {
  rows: DiscoverRow[];
};

export function totalRowPrice(row: DiscoverRow): number | null {
  if (row.inputUsdPerMillion === null || row.outputUsdPerMillion === null) return null;
  return row.inputUsdPerMillion + row.outputUsdPerMillion;
}

function minPrice(values: Array<number | null>): number | null {
  let min: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    min = min === null ? value : Math.min(min, value);
  }
  return min;
}

function maxPrice(values: Array<number | null>): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function projectGroupToEntry(group: ModelCatalogGroup): VprModelCatalogEntry {
  const firstRow = group.rows[0];
  const categories = Array.from(new Set(group.rows.flatMap((row) => row.categories))).sort((a, b) => a.localeCompare(b));
  const peerIds = new Set(group.rows.map((row) => row.peerId));
  const pricedRows = group.rows
    .map((row) => ({ row, total: totalRowPrice(row) }))
    .filter((route): route is { row: DiscoverRow; total: number } => route.total !== null);
  const bestPricedRoute = pricedRows.reduce<{ row: DiscoverRow; total: number } | null>((best, route) => {
    if (best === null || route.total < best.total) return route;
    return best;
  }, null);
  const minTotal = minPrice(pricedRows.map((route) => route.total));
  const maxTotal = maxPrice(pricedRows.map((route) => route.total));
  const expectedSavingsPct = pricedRows.length >= 2 && minTotal !== null && maxTotal !== null && maxTotal > minTotal
    ? Math.round((1 - minTotal / maxTotal) * 100)
    : null;

  // The entry's provider/serviceId must stay consistent with bestPeerId —
  // selecting the entry dispatches this exact advertised pair, and the buyer
  // proxy strictly gates on what the pinned peer actually serves.
  const representative = bestPricedRoute?.row ?? firstRow;
  const label = displayModelLabel(
    representative.serviceId,
    group.rows.find((row) => row.serviceLabel.trim().length > 0)?.serviceLabel,
  );

  return {
    provider: representative.provider,
    serviceId: representative.serviceId,
    label,
    peerCount: peerIds.size,
    categories,
    minInputUsdPerMillion: bestPricedRoute?.row.inputUsdPerMillion ?? null,
    maxInputUsdPerMillion: maxPrice(group.rows.map((row) => row.inputUsdPerMillion)),
    minOutputUsdPerMillion: bestPricedRoute?.row.outputUsdPerMillion ?? null,
    maxOutputUsdPerMillion: maxPrice(group.rows.map((row) => row.outputUsdPerMillion)),
    expectedSavingsPct,
    bestPeerId: bestPricedRoute?.row.peerId ?? firstRow?.peerId ?? null,
  };
}

export function projectRowsToVprModelCatalog(rows: DiscoverRow[]): VprModelCatalogEntry[] {
  const groups = new Map<string, ModelCatalogGroup>();
  for (const row of rows) {
    // Aggregate by canonical model identity so cosmetic serviceId/provider
    // variations of the same model collapse into one entry.
    const key = canonicalModelKey(row.serviceId)
      || `${row.provider}${VPR_MODEL_CATALOG_SEPARATOR}${row.serviceId}`;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, { rows: [row] });
    }
  }

  return Array.from(groups.values())
    .map(projectGroupToEntry)
    .sort((a, b) => b.peerCount - a.peerCount || a.label.localeCompare(b.label));
}

export function selectDefaultVprModel(
  catalog: VprModelCatalogEntry[],
  current: VprSelectedModel | null,
): VprSelectedModel | null {
  if (current && findCatalogEntry(catalog, current.provider, current.serviceId)) return current;
  // First launch defaults to a free model — trying the VPR must cost nothing
  // before any balance exists. Prefer a free model from the recommended
  // lineup, then any free model on the network, then the recommended/popular
  // fallback for networks without a free seller.
  const recommended = selectRecommendedVprCatalog(catalog);
  const first = recommended.find(isFreeCatalogEntry)
    ?? catalog.find(isFreeCatalogEntry)
    ?? recommended[0]
    ?? catalog[0];
  if (!first) return null;
  return {
    provider: first.provider,
    serviceId: first.serviceId,
    label: first.label,
    categories: [...first.categories],
  };
}

export function findCatalogEntry(
  catalog: VprModelCatalogEntry[],
  provider: string,
  serviceId: string,
): VprModelCatalogEntry | null {
  return catalog.find((entry) => entry.provider === provider && entry.serviceId === serviceId)
    // Entries aggregate serviceId variants — match any variant canonically so
    // selections that reference a sibling key still resolve to the entry.
    ?? catalog.find((entry) => sameCanonicalModel(entry.serviceId, serviceId))
    ?? null;
}
