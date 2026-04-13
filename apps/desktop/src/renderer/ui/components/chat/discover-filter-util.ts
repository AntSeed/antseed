import type { DiscoverRow } from '../../../core/state';

export type DiscoverSortKey =
  | 'recentlyUsed'
  | 'serviceAsc' | 'serviceDesc'
  | 'inputAsc' | 'inputDesc'
  | 'outputAsc' | 'outputDesc'
  | 'cachedInputAsc' | 'cachedInputDesc'
  | 'stakeDesc'
  | 'volumeDesc'
  | 'lastSettledDesc'
  | 'stakedAtAsc' | 'stakedAtDesc';

export type DiscoverPriceBucket = 'any' | 'free' | 'lt1' | '1to5' | 'gt5';

export type DiscoverFilterInputs = {
  search: string;
  categorySet: Set<string>;
  priceBucket: DiscoverPriceBucket;
  cachedOnly: boolean;
  chattedOnly: boolean;
  minStakeUsdc: string;
};

export function matchesSearch(row: DiscoverRow, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (row.serviceLabel.toLowerCase().includes(needle)) return true;
  if ((row.peerDisplayName ?? '').toLowerCase().includes(needle)) return true;
  if (row.peerLabel.toLowerCase().includes(needle)) return true;
  for (const c of row.categories) {
    if (c.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function matchesPriceBucket(row: DiscoverRow, bucket: DiscoverPriceBucket): boolean {
  if (bucket === 'any') return true;
  const input = row.inputUsdPerMillion;
  if (input == null) return false;
  switch (bucket) {
    case 'free':  return input === 0;
    case 'lt1':   return input > 0 && input < 1;
    case '1to5':  return input >= 1 && input <= 5;
    case 'gt5':   return input > 5;
    default:      return true;
  }
}

export function matchesCategoryFilter(row: DiscoverRow, set: Set<string>): boolean {
  if (set.size === 0) return true;
  return row.categories.some((c) => set.has(c.toLowerCase()));
}

export function matchesCachedOnly(row: DiscoverRow, enabled: boolean): boolean {
  if (!enabled) return true;
  const cached = row.cachedInputUsdPerMillion;
  const input = row.inputUsdPerMillion;
  return cached != null && input != null && cached < input;
}

export function matchesMinStake(row: DiscoverRow, minStakeUsdc: string): boolean {
  if (!minStakeUsdc.trim()) return true;
  const parsed = Number(minStakeUsdc);
  if (!Number.isFinite(parsed) || parsed < 0) return true;
  const rowStake = Number(BigInt(row.stakeUsdc) / 1_000_000n);
  return rowStake >= parsed;
}

export function applyFilters(rows: DiscoverRow[], inputs: DiscoverFilterInputs): DiscoverRow[] {
  return rows.filter((row) =>
    matchesSearch(row, inputs.search)
    && matchesCategoryFilter(row, inputs.categorySet)
    && matchesPriceBucket(row, inputs.priceBucket)
    && matchesCachedOnly(row, inputs.cachedOnly)
    && (inputs.chattedOnly ? row.lifetimeSessions > 0 : true)
    && matchesMinStake(row, inputs.minStakeUsdc)
  );
}

export function applySort(rows: DiscoverRow[], key: DiscoverSortKey, dir: 'asc' | 'desc'): DiscoverRow[] {
  const out = rows.slice();
  const cmp = (a: DiscoverRow, b: DiscoverRow): number => {
    switch (key) {
      case 'recentlyUsed': {
        const aHas = a.lifetimeSessions > 0 ? 1 : 0;
        const bHas = b.lifetimeSessions > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        if (aHas === 1) {
          const aTs = a.lifetimeLastSessionAt ?? 0;
          const bTs = b.lifetimeLastSessionAt ?? 0;
          if (aTs !== bTs) return bTs - aTs;
        }
        return a.serviceLabel.localeCompare(b.serviceLabel);
      }
      case 'serviceAsc':
      case 'serviceDesc':
        return a.serviceLabel.localeCompare(b.serviceLabel);
      case 'inputAsc':
      case 'inputDesc':
        return (a.inputUsdPerMillion ?? Number.POSITIVE_INFINITY) - (b.inputUsdPerMillion ?? Number.POSITIVE_INFINITY);
      case 'outputAsc':
      case 'outputDesc':
        return (a.outputUsdPerMillion ?? Number.POSITIVE_INFINITY) - (b.outputUsdPerMillion ?? Number.POSITIVE_INFINITY);
      case 'cachedInputAsc':
      case 'cachedInputDesc':
        return (a.cachedInputUsdPerMillion ?? Number.POSITIVE_INFINITY) - (b.cachedInputUsdPerMillion ?? Number.POSITIVE_INFINITY);
      case 'stakeDesc':
        return Number(BigInt(b.stakeUsdc) - BigInt(a.stakeUsdc));
      case 'volumeDesc':
        return Number(BigInt(b.onChainTotalVolumeUsdc) - BigInt(a.onChainTotalVolumeUsdc));
      case 'lastSettledDesc':
        return b.onChainLastSettledAt - a.onChainLastSettledAt;
      case 'stakedAtAsc':
      case 'stakedAtDesc':
        return a.stakedAt - b.stakedAt;
      default:
        return 0;
    }
  };

  out.sort((a, b) => {
    const base = cmp(a, b);
    if (key === 'serviceDesc' || key === 'inputDesc' || key === 'outputDesc' || key === 'cachedInputDesc' || key === 'stakedAtDesc') {
      return -base;
    }
    if (dir === 'desc' && (key === 'recentlyUsed' || key === 'stakeDesc' || key === 'volumeDesc' || key === 'lastSettledDesc')) {
      return base;
    }
    return base;
  });
  return out;
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (Math.max(1, page) - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function totalPagesFor(totalResults: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalResults / pageSize));
}
