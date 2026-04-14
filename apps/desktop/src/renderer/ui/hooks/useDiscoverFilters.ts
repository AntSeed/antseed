import { useMemo, useState, useCallback } from 'react';
import type { DiscoverRow } from '../../core/state';
import { getPeerGradient } from '../../core/peer-utils';
import {
  applyFilters, applySort,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
  type DiscoverSortKey, type TimeWindow,
} from '../components/chat/discover-filter-util';

export type DiscoverPeerOption = {
  peerId: string;
  label: string;
  letter: string;
  gradient: string;
};

export type DiscoverFilterState = {
  search: string;
  categorySet: Set<string>;
  peerSet: Set<string>;
  maxInputPrice: number;
  maxOutputPrice: number;
  chattedOnly: boolean;
  minStakeUsdc: number;
  lastSeenWindow: TimeWindow;
  lastSettledWindow: TimeWindow;
  minVolumeUsdc: number;
  sortKey: DiscoverSortKey;

  sortedRows: DiscoverRow[];
  availableCategories: string[];
  availablePeers: DiscoverPeerOption[];

  setSearch: (v: string) => void;
  toggleCategory: (cat: string) => void;
  togglePeer: (peerId: string) => void;
  setMaxInputPrice: (v: number) => void;
  setMaxOutputPrice: (v: number) => void;
  setChattedOnly: (v: boolean) => void;
  setMinStakeUsdc: (v: number) => void;
  setLastSeenWindow: (v: TimeWindow) => void;
  setLastSettledWindow: (v: TimeWindow) => void;
  setMinVolumeUsdc: (v: number) => void;
  setSortKey: (k: DiscoverSortKey) => void;
  resetAll: () => void;
};

export function useDiscoverFilters(rows: DiscoverRow[]): DiscoverFilterState {
  const [search, setSearch] = useState('');
  const [categorySet, setCategorySet] = useState<Set<string>>(() => new Set());
  const [peerSet, setPeerSet] = useState<Set<string>>(() => new Set());
  const [maxInputPrice, setMaxInputPrice] = useState<number>(MAX_INPUT_PRICE_SLIDER_USD);
  const [maxOutputPrice, setMaxOutputPrice] = useState<number>(MAX_OUTPUT_PRICE_SLIDER_USD);
  const [chattedOnly, setChattedOnly] = useState(false);
  const [minStakeUsdc, setMinStakeUsdc] = useState<number>(0);
  const [lastSeenWindow, setLastSeenWindow] = useState<TimeWindow>('any');
  const [lastSettledWindow, setLastSettledWindow] = useState<TimeWindow>('any');
  const [minVolumeUsdc, setMinVolumeUsdc] = useState<number>(0);
  const [sortKey, setSortKey] = useState<DiscoverSortKey>('volumeDesc');

  const toggleCategory = useCallback((cat: string) => {
    setCategorySet((prev) => {
      const next = new Set(prev);
      const key = cat.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const togglePeer = useCallback((peerId: string) => {
    setPeerSet((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    setSearch('');
    setCategorySet(new Set());
    setPeerSet(new Set());
    setMaxInputPrice(MAX_INPUT_PRICE_SLIDER_USD);
    setMaxOutputPrice(MAX_OUTPUT_PRICE_SLIDER_USD);
    setChattedOnly(false);
    setMinStakeUsdc(0);
    setLastSeenWindow('any');
    setLastSettledWindow('any');
    setMinVolumeUsdc(0);
    setSortKey('volumeDesc');
  }, []);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const c of r.categories) set.add(c);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const availablePeers = useMemo<DiscoverPeerOption[]>(() => {
    const seen = new Map<string, DiscoverPeerOption>();
    for (const r of rows) {
      if (!r.peerId || seen.has(r.peerId)) continue;
      const label = r.peerDisplayName?.trim() || r.peerLabel?.trim() || r.peerId;
      const gradient = getPeerGradient(r.peerId || r.peerLabel || r.provider || r.serviceId);
      const letter = (label || '?').charAt(0).toUpperCase();
      seen.set(r.peerId, { peerId: r.peerId, label, letter, gradient });
    }
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const filteredRows = useMemo(
    () => applyFilters(rows, {
      search, categorySet, peerSet, maxInputPrice, maxOutputPrice, chattedOnly, minStakeUsdc,
      lastSeenWindow, lastSettledWindow, minVolumeUsdc,
    }),
    [rows, search, categorySet, peerSet, maxInputPrice, maxOutputPrice, chattedOnly, minStakeUsdc,
      lastSeenWindow, lastSettledWindow, minVolumeUsdc],
  );

  const sortedRows = useMemo(
    () => applySort(filteredRows, sortKey, 'desc'),
    [filteredRows, sortKey],
  );

  return {
    search,
    categorySet,
    peerSet,
    maxInputPrice,
    maxOutputPrice,
    chattedOnly,
    minStakeUsdc,
    lastSeenWindow,
    lastSettledWindow,
    minVolumeUsdc,
    sortKey,

    sortedRows,
    availableCategories,
    availablePeers,

    setSearch,
    toggleCategory,
    togglePeer,
    setMaxInputPrice,
    setMaxOutputPrice,
    setChattedOnly,
    setMinStakeUsdc,
    setLastSeenWindow,
    setLastSettledWindow,
    setMinVolumeUsdc,
    setSortKey,
    resetAll,
  };
}
