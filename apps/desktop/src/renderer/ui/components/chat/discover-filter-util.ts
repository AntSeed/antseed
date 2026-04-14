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

export const MAX_INPUT_PRICE_SLIDER_USD = 3;
export const INPUT_PRICE_SLIDER_STEP = 0.1;
export const MAX_OUTPUT_PRICE_SLIDER_USD = 3;
export const OUTPUT_PRICE_SLIDER_STEP = 0.1;
export const MAX_CHANNELS_SLIDER = 100;
export const CHANNELS_SLIDER_STEP = 10;
export const MAX_REQUESTS_SLIDER = 5000;
export const REQUESTS_SLIDER_STEP = 100;
export const MAX_TOKENS_SLIDER = 100_000_000;
export const TOKENS_SLIDER_STEP = 500_000;
export const MAX_STAKE_SLIDER_USDC = 1000;

export type TimeWindow = 'any' | 'today' | 'week' | 'month';

export type DiscoverFilterInputs = {
  search: string;
  categorySet: Set<string>;
  maxInputPrice: number;
  maxOutputPrice: number;
  cachedOnly: boolean;
  chattedOnly: boolean;
  lastSeenWindow: TimeWindow;
  lastSettledWindow: TimeWindow;
  minStakeUsdc: number;
  minChannels: number;
  minRequests: number;
  minTokens: number;
};

function parseBigintSafe(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try { return BigInt(value); } catch { return 0n; }
}

export function hasBeenUsed(row: DiscoverRow): boolean {
  return row.lifetimeRequests > 0
    || row.lifetimeSessions > 0
    || row.lifetimeInputTokens > 0
    || row.lifetimeOutputTokens > 0
    || row.lifetimeLastSessionAt != null;
}

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

export function matchesMaxInputPrice(row: DiscoverRow, maxPrice: number): boolean {
  if (maxPrice >= MAX_INPUT_PRICE_SLIDER_USD) return true;
  const input = row.inputUsdPerMillion;
  if (input == null) return false;
  return input <= maxPrice;
}

export function matchesMaxOutputPrice(row: DiscoverRow, maxPrice: number): boolean {
  if (maxPrice >= MAX_OUTPUT_PRICE_SLIDER_USD) return true;
  const output = row.outputUsdPerMillion;
  if (output == null) return false;
  return output <= maxPrice;
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

export function matchesMinStake(row: DiscoverRow, minStakeUsdc: number): boolean {
  if (minStakeUsdc <= 0) return true;
  const rowStake = Number(BigInt(row.stakeUsdc) / 1_000_000n);
  return rowStake >= minStakeUsdc;
}

export function matchesTimeWindow(
  ts: number | null | undefined,
  window: TimeWindow,
  unit: 'ms' | 'sec',
  nowMs: number = Date.now(),
): boolean {
  if (window === 'any') return true;
  if (!ts || ts <= 0) return false;
  const tsMs = unit === 'sec' ? ts * 1000 : ts;
  const diffMs = nowMs - tsMs;
  switch (window) {
    case 'today': return diffMs < 24 * 3600 * 1000;
    case 'week':  return diffMs < 7 * 24 * 3600 * 1000;
    case 'month': return diffMs < 30 * 24 * 3600 * 1000;
  }
  return true;
}

export function matchesLastSeen(row: DiscoverRow, window: TimeWindow, nowMs?: number): boolean {
  return matchesTimeWindow(row.lifetimeLastSessionAt, window, 'ms', nowMs);
}

export function matchesLastSettled(row: DiscoverRow, window: TimeWindow, nowMs?: number): boolean {
  return matchesTimeWindow(row.onChainLastSettledAt, window, 'sec', nowMs);
}

export function matchesMinChannels(row: DiscoverRow, minChannels: number): boolean {
  if (minChannels <= 0) return true;
  return row.onChainActiveChannelCount >= minChannels;
}

export function pickRequests(row: DiscoverRow): bigint {
  if (row.networkRequests !== null) return parseBigintSafe(row.networkRequests);
  return BigInt(row.lifetimeRequests);
}

export function pickTokens(row: DiscoverRow): bigint {
  if (row.networkInputTokens !== null || row.networkOutputTokens !== null) {
    return parseBigintSafe(row.networkInputTokens) + parseBigintSafe(row.networkOutputTokens);
  }
  return BigInt(row.lifetimeInputTokens + row.lifetimeOutputTokens);
}

export function matchesMinRequests(row: DiscoverRow, minRequests: number): boolean {
  if (minRequests <= 0) return true;
  return pickRequests(row) >= BigInt(minRequests);
}

export function matchesMinTokens(row: DiscoverRow, minTokens: number): boolean {
  if (minTokens <= 0) return true;
  return pickTokens(row) >= BigInt(minTokens);
}

export function applyFilters(rows: DiscoverRow[], inputs: DiscoverFilterInputs): DiscoverRow[] {
  const nowMs = Date.now();
  return rows.filter((row) =>
    matchesSearch(row, inputs.search)
    && matchesCategoryFilter(row, inputs.categorySet)
    && matchesMaxInputPrice(row, inputs.maxInputPrice)
    && matchesMaxOutputPrice(row, inputs.maxOutputPrice)
    && matchesCachedOnly(row, inputs.cachedOnly)
    && (inputs.chattedOnly ? hasBeenUsed(row) : true)
    && matchesMinStake(row, inputs.minStakeUsdc)
    && matchesLastSeen(row, inputs.lastSeenWindow, nowMs)
    && matchesLastSettled(row, inputs.lastSettledWindow, nowMs)
    && matchesMinChannels(row, inputs.minChannels)
    && matchesMinRequests(row, inputs.minRequests)
    && matchesMinTokens(row, inputs.minTokens)
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
