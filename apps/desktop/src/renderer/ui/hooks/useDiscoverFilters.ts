import { useMemo, useState, useCallback } from 'react';
import type { DiscoverRow } from '../../core/state';
import {
  applyFilters, applySort,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
  type DiscoverSortKey, type TimeWindow,
} from '../components/chat/discover-filter-util';

export type DiscoverFilterState = {
  search: string;
  categorySet: Set<string>;
  maxInputPrice: number;
  maxOutputPrice: number;
  cachedOnly: boolean;
  chattedOnly: boolean;
  minStakeUsdc: number;
  lastSeenWindow: TimeWindow;
  lastSettledWindow: TimeWindow;
  minChannels: number;
  minRequests: number;
  minTokens: number;
  sortKey: DiscoverSortKey;

  sortedRows: DiscoverRow[];
  availableCategories: string[];

  setSearch: (v: string) => void;
  toggleCategory: (cat: string) => void;
  setMaxInputPrice: (v: number) => void;
  setMaxOutputPrice: (v: number) => void;
  setCachedOnly: (v: boolean) => void;
  setChattedOnly: (v: boolean) => void;
  setMinStakeUsdc: (v: number) => void;
  setLastSeenWindow: (v: TimeWindow) => void;
  setLastSettledWindow: (v: TimeWindow) => void;
  setMinChannels: (v: number) => void;
  setMinRequests: (v: number) => void;
  setMinTokens: (v: number) => void;
  setSortKey: (k: DiscoverSortKey) => void;
  resetAll: () => void;
};

export function useDiscoverFilters(rows: DiscoverRow[]): DiscoverFilterState {
  const [search, setSearch] = useState('');
  const [categorySet, setCategorySet] = useState<Set<string>>(() => new Set());
  const [maxInputPrice, setMaxInputPrice] = useState<number>(MAX_INPUT_PRICE_SLIDER_USD);
  const [maxOutputPrice, setMaxOutputPrice] = useState<number>(MAX_OUTPUT_PRICE_SLIDER_USD);
  const [cachedOnly, setCachedOnly] = useState(false);
  const [chattedOnly, setChattedOnly] = useState(false);
  const [minStakeUsdc, setMinStakeUsdc] = useState<number>(0);
  const [lastSeenWindow, setLastSeenWindow] = useState<TimeWindow>('any');
  const [lastSettledWindow, setLastSettledWindow] = useState<TimeWindow>('any');
  const [minChannels, setMinChannels] = useState<number>(0);
  const [minRequests, setMinRequests] = useState<number>(0);
  const [minTokens, setMinTokens] = useState<number>(0);
  const [sortKey, setSortKey] = useState<DiscoverSortKey>('recentlyUsed');

  const toggleCategory = useCallback((cat: string) => {
    setCategorySet((prev) => {
      const next = new Set(prev);
      const key = cat.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    setSearch('');
    setCategorySet(new Set());
    setMaxInputPrice(MAX_INPUT_PRICE_SLIDER_USD);
    setMaxOutputPrice(MAX_OUTPUT_PRICE_SLIDER_USD);
    setCachedOnly(false);
    setChattedOnly(false);
    setMinStakeUsdc(0);
    setLastSeenWindow('any');
    setLastSettledWindow('any');
    setMinChannels(0);
    setMinRequests(0);
    setMinTokens(0);
    setSortKey('recentlyUsed');
  }, []);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const c of r.categories) set.add(c);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(
    () => applyFilters(rows, {
      search, categorySet, maxInputPrice, maxOutputPrice, cachedOnly, chattedOnly, minStakeUsdc,
      lastSeenWindow, lastSettledWindow, minChannels, minRequests, minTokens,
    }),
    [rows, search, categorySet, maxInputPrice, maxOutputPrice, cachedOnly, chattedOnly, minStakeUsdc,
      lastSeenWindow, lastSettledWindow, minChannels, minRequests, minTokens],
  );

  const sortedRows = useMemo(
    () => applySort(filteredRows, sortKey, 'desc'),
    [filteredRows, sortKey],
  );

  return {
    search,
    categorySet,
    maxInputPrice,
    maxOutputPrice,
    cachedOnly,
    chattedOnly,
    minStakeUsdc,
    lastSeenWindow,
    lastSettledWindow,
    minChannels,
    minRequests,
    minTokens,
    sortKey,

    sortedRows,
    availableCategories,

    setSearch,
    toggleCategory,
    setMaxInputPrice,
    setMaxOutputPrice,
    setCachedOnly,
    setChattedOnly,
    setMinStakeUsdc,
    setLastSeenWindow,
    setLastSettledWindow,
    setMinChannels,
    setMinRequests,
    setMinTokens,
    setSortKey,
    resetAll,
  };
}
