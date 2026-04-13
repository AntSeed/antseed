import { useMemo, useState, useCallback } from 'react';
import type { DiscoverRow } from '../../core/state';
import {
  applyFilters, applySort,
  type DiscoverSortKey, type DiscoverPriceBucket,
} from '../components/chat/discover-filter-util';

export type DiscoverFilterState = {
  search: string;
  categorySet: Set<string>;
  priceBucket: DiscoverPriceBucket;
  cachedOnly: boolean;
  chattedOnly: boolean;
  minStakeUsdc: string;
  sortKey: DiscoverSortKey;

  sortedRows: DiscoverRow[];
  availableCategories: string[];

  setSearch: (v: string) => void;
  toggleCategory: (cat: string) => void;
  setPriceBucket: (b: DiscoverPriceBucket) => void;
  setCachedOnly: (v: boolean) => void;
  setChattedOnly: (v: boolean) => void;
  setMinStakeUsdc: (v: string) => void;
  setSortKey: (k: DiscoverSortKey) => void;
  resetAll: () => void;
};

export function useDiscoverFilters(rows: DiscoverRow[]): DiscoverFilterState {
  const [search, setSearch] = useState('');
  const [categorySet, setCategorySet] = useState<Set<string>>(() => new Set());
  const [priceBucket, setPriceBucket] = useState<DiscoverPriceBucket>('any');
  const [cachedOnly, setCachedOnly] = useState(false);
  const [chattedOnly, setChattedOnly] = useState(false);
  const [minStakeUsdc, setMinStakeUsdc] = useState('');
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
    setPriceBucket('any');
    setCachedOnly(false);
    setChattedOnly(false);
    setMinStakeUsdc('');
    setSortKey('recentlyUsed');
  }, []);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const c of r.categories) set.add(c);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(
    () => applyFilters(rows, { search, categorySet, priceBucket, cachedOnly, chattedOnly, minStakeUsdc }),
    [rows, search, categorySet, priceBucket, cachedOnly, chattedOnly, minStakeUsdc],
  );

  const sortedRows = useMemo(
    () => applySort(filteredRows, sortKey, 'desc'),
    [filteredRows, sortKey],
  );

  return {
    search,
    categorySet,
    priceBucket,
    cachedOnly,
    chattedOnly,
    minStakeUsdc,
    sortKey,

    sortedRows,
    availableCategories,

    setSearch,
    toggleCategory,
    setPriceBucket,
    setCachedOnly,
    setChattedOnly,
    setMinStakeUsdc,
    setSortKey,
    resetAll,
  };
}
