import type { DiscoverRow } from '../../../core/state';

export type DiscoverSortKey =
  | 'recentlyUsed'
  | 'serviceAsc' | 'serviceDesc'
  | 'priceAsc' | 'priceDesc'
  | 'stakeDesc'
  | 'channelsDesc'
  | 'lastSettledDesc';

export const MAX_INPUT_PRICE_SLIDER_USD = 3;
export const INPUT_PRICE_SLIDER_STEP = 0.1;
export const MAX_OUTPUT_PRICE_SLIDER_USD = 3;
export const OUTPUT_PRICE_SLIDER_STEP = 0.1;
export const MAX_STAKE_SLIDER_USDC = 1000;

export const MAX_CHANNELS_SLIDER = 200;
export const CHANNELS_SLIDER_STEP = 5;

/**
 * Default minimum on-chain channel count for Discover. 20 hides brand-new peers
 * that haven't accumulated a track record while still showing modestly-active ones.
 * Users can lower the slider to 0 to see every peer.
 */
export const DEFAULT_MIN_ON_CHAIN_CHANNELS = 20;

export type TimeWindow = 'any' | 'today' | 'week' | 'month';

/**
 * Friendlier display labels for raw lowercase category tags announced by
 * sellers. The map is deliberately small — only tags whose raw form is
 * opaque to end users get a rewrite. Everything else passes through as-is.
 *
 * The underlying data (categorySet, row.categories, search matching) still
 * uses the raw tag — this is purely a render-time convenience.
 */
const CATEGORY_DISPLAY_LABELS: Record<string, string> = {
  multimodal: 'image upload',
};

export function formatCategoryLabel(category: string): string {
  const key = category.trim().toLowerCase();
  return CATEGORY_DISPLAY_LABELS[key] ?? category;
}

export type DiscoverFilterInputs = {
  search: string;
  categorySet: Set<string>;
  peerSet: Set<string>;
  maxInputPrice: number;
  maxOutputPrice: number;
  chattedOnly: boolean;
  lastSeenWindow: TimeWindow;
  lastSettledWindow: TimeWindow;
  minStakeUsdc: number;
  minOnChainChannels: number;
};

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

export function matchesPeerFilter(row: DiscoverRow, set: Set<string>): boolean {
  if (set.size === 0) return true;
  return set.has(row.peerId);
}

export function matchesMinStake(row: DiscoverRow, minStakeUsdc: number): boolean {
  if (minStakeUsdc <= 0) return true;
  const stakeUsdc = Number(row.stakeUsdc) / 1_000_000;
  return stakeUsdc >= minStakeUsdc;
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

/**
 * Effective on-chain channel count for a peer. Prefers the live value from
 * AntseedChannels.getAgentStats; falls back to the peer-metadata count while
 * chain stats haven't loaded yet.
 */
export function rowChannelCount(row: DiscoverRow): number {
  const active = row.onChainActiveChannelCount ?? 0;
  const meta = row.onChainChannelCount ?? 0;
  return Math.max(active, meta);
}

export function matchesMinChannels(row: DiscoverRow, minChannels: number): boolean {
  if (minChannels <= 0) return true;
  return rowChannelCount(row) >= minChannels;
}

export function applyFilters(rows: DiscoverRow[], inputs: DiscoverFilterInputs): DiscoverRow[] {
  const nowMs = Date.now();
  return rows.filter((row) =>
    matchesSearch(row, inputs.search)
    && matchesCategoryFilter(row, inputs.categorySet)
    && matchesPeerFilter(row, inputs.peerSet)
    && matchesMaxInputPrice(row, inputs.maxInputPrice)
    && matchesMaxOutputPrice(row, inputs.maxOutputPrice)
    && (inputs.chattedOnly ? hasBeenUsed(row) : true)
    && matchesMinStake(row, inputs.minStakeUsdc)
    && matchesLastSeen(row, inputs.lastSeenWindow, nowMs)
    && matchesLastSettled(row, inputs.lastSettledWindow, nowMs)
    && matchesMinChannels(row, inputs.minOnChainChannels)
  );
}

export function applySort(rows: DiscoverRow[], key: DiscoverSortKey, dir: 'asc' | 'desc'): DiscoverRow[] {
  const out = rows.slice();
  const priceOf = (r: DiscoverRow): number => {
    const inp = r.inputUsdPerMillion;
    const out = r.outputUsdPerMillion;
    if (inp == null && out == null) return Number.POSITIVE_INFINITY;
    return (inp ?? 0) + (out ?? 0);
  };
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
      case 'priceAsc':
      case 'priceDesc':
        return priceOf(a) - priceOf(b);
      case 'stakeDesc':
        return Number(BigInt(b.stakeUsdc) - BigInt(a.stakeUsdc));
      case 'channelsDesc': {
        const diff = rowChannelCount(b) - rowChannelCount(a);
        if (diff !== 0) return diff;
        return priceOf(a) - priceOf(b);
      }
      case 'lastSettledDesc':
        return b.onChainLastSettledAt - a.onChainLastSettledAt;
      default:
        return 0;
    }
  };

  out.sort((a, b) => {
    const base = cmp(a, b);
    if (key === 'serviceDesc' || key === 'priceDesc') {
      return -base;
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

/* ── Price preset buckets (used by inline Price filter dropdown) ──────── */

/**
 * Common price ceilings users can pick inline without opening the drawer.
 * Each preset's `cap` is applied to BOTH `maxInputPrice` and `maxOutputPrice`
 * — a row passes only if both sides are at or below the cap.
 *
 * The 'any' preset's cap equals the slider max so default state (no filtering)
 * round-trips cleanly through `matchPricePreset`. If the input and output
 * slider maxes ever diverge, replace the single `cap` with separate
 * `inputCap` / `outputCap` and update `matchPricePreset` accordingly.
 */
export const PRICE_PRESETS = [
  { id: 'any',  label: 'Any',           cap: MAX_INPUT_PRICE_SLIDER_USD },
  { id: 'free', label: 'Free only',     cap: 0 },
  { id: 'p10',  label: 'Under $0.10/M', cap: 0.10 },
  { id: 'p100', label: 'Under $1/M',    cap: 1.00 },
] as const;

export type PricePresetId = typeof PRICE_PRESETS[number]['id'];

/* ── Sort options (single source of truth for sort dropdown) ─────────── */

export const SORT_OPTIONS: ReadonlyArray<{ key: DiscoverSortKey; label: string }> = [
  { key: 'channelsDesc',    label: 'Most channels' },
  { key: 'recentlyUsed',    label: 'Recently used' },
  { key: 'serviceAsc',      label: 'Name A–Z' },
  { key: 'serviceDesc',     label: 'Name Z–A' },
  { key: 'priceAsc',        label: 'Price low to high' },
  { key: 'priceDesc',       label: 'Price high to low' },
  { key: 'stakeDesc',       label: 'Most staked' },
  { key: 'lastSettledDesc', label: 'Recently settled' },
];

const PRICE_EPSILON = 0.001;

export function matchPricePreset(
  input: number,
  output: number,
): PricePresetId | 'custom' {
  for (const p of PRICE_PRESETS) {
    if (Math.abs(input - p.cap) < PRICE_EPSILON && Math.abs(output - p.cap) < PRICE_EPSILON) {
      return p.id;
    }
  }
  return 'custom';
}
