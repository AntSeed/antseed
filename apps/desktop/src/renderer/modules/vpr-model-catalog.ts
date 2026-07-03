import type { DiscoverRow, VprModelCatalogEntry, VprSelectedModel } from '../core/state';

const VPR_MODEL_CATALOG_SEPARATOR = '\u0001';

type ModelCatalogGroup = {
  provider: string;
  serviceId: string;
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
  const label = group.rows.find((row) => row.serviceLabel.trim().length > 0)?.serviceLabel ?? group.serviceId;
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

  return {
    provider: group.provider,
    serviceId: group.serviceId,
    label,
    peerCount: peerIds.size,
    categories,
    minInputUsdPerMillion: minPrice(group.rows.map((row) => row.inputUsdPerMillion)),
    maxInputUsdPerMillion: maxPrice(group.rows.map((row) => row.inputUsdPerMillion)),
    minOutputUsdPerMillion: minPrice(group.rows.map((row) => row.outputUsdPerMillion)),
    maxOutputUsdPerMillion: maxPrice(group.rows.map((row) => row.outputUsdPerMillion)),
    expectedSavingsPct,
    bestPeerId: bestPricedRoute?.row.peerId ?? firstRow?.peerId ?? null,
  };
}

export function projectRowsToVprModelCatalog(rows: DiscoverRow[]): VprModelCatalogEntry[] {
  const groups = new Map<string, ModelCatalogGroup>();
  for (const row of rows) {
    const key = `${row.provider}${VPR_MODEL_CATALOG_SEPARATOR}${row.serviceId}`;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, {
        provider: row.provider,
        serviceId: row.serviceId,
        rows: [row],
      });
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
  const first = catalog[0];
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
  return catalog.find((entry) => entry.provider === provider && entry.serviceId === serviceId) ?? null;
}
