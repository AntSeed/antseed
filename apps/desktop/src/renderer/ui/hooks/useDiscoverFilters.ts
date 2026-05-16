import { useMemo, useState, useCallback } from 'react';
import type { DiscoverRow } from '../../core/state';
import { getPeerGradient } from '../../core/peer-utils';
import { getKnownProxy, type KnownProxy } from '../../core/known-proxies';
import {
  applyFilters, applySort, rowReputationScore,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
  DEFAULT_MIN_REPUTATION_SCORE,
  type DiscoverSortKey,
} from '../components/chat/discover-filter-util';

export type DiscoverPeerOption = {
  peerId: string;
  label: string;
  letter: string;
  gradient: string;
  /**
   * Metadata for a recognised on-chain seller-proxy contract (e.g. the DIEM
   * Staking Pool). Surfaced as a tiny contract icon next to the peer name in
   * the Discover peer-filter list and the chat sidebar so users can tell at
   * a glance which peers route settlement through a known pool. `null` for
   * peers that settle directly to their own derived address.
   */
  knownProxy: KnownProxy | null;
};

export type DiscoverFilterState = {
  search: string;
  categorySet: Set<string>;
  peerSet: Set<string>;
  maxInputPrice: number;
  maxOutputPrice: number;
  minStakeUsdc: number;
  minReputationScore: number;
  sortKey: DiscoverSortKey;

  sortedRows: DiscoverRow[];
  availableCategories: string[];
  availablePeers: DiscoverPeerOption[];

  setSearch: (v: string) => void;
  toggleCategory: (cat: string) => void;
  togglePeer: (peerId: string) => void;
  setMaxInputPrice: (v: number) => void;
  setMaxOutputPrice: (v: number) => void;
  setMinStakeUsdc: (v: number) => void;
  setMinReputationScore: (v: number) => void;
  setSortKey: (k: DiscoverSortKey) => void;
  resetAll: () => void;
};

export function useDiscoverFilters(rows: DiscoverRow[]): DiscoverFilterState {
  const [search, setSearch] = useState('');
  const [categorySet, setCategorySet] = useState<Set<string>>(() => new Set());
  const [peerSet, setPeerSet] = useState<Set<string>>(() => new Set());
  const [maxInputPrice, setMaxInputPrice] = useState<number>(MAX_INPUT_PRICE_SLIDER_USD);
  const [maxOutputPrice, setMaxOutputPrice] = useState<number>(MAX_OUTPUT_PRICE_SLIDER_USD);
  const [minStakeUsdc, setMinStakeUsdc] = useState<number>(0);
  const [minReputationScore, setMinReputationScore] = useState<number>(DEFAULT_MIN_REPUTATION_SCORE);
  const [sortKey, setSortKey] = useState<DiscoverSortKey>('reputationDesc');

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
    setMinStakeUsdc(0);
    setMinReputationScore(DEFAULT_MIN_REPUTATION_SCORE);
    setSortKey('reputationDesc');
  }, []);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const c of r.categories) set.add(c);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const availablePeers = useMemo<DiscoverPeerOption[]>(() => {
    // One entry per peer, ranked by on-chain reputation so strong activity
    // floats to the top of the sidebar without hiding brand-new peers.
    const seen = new Map<string, { opt: DiscoverPeerOption; score: number; label: string }>();
    for (const r of rows) {
      if (!r.peerId || seen.has(r.peerId)) continue;
      const label = r.peerDisplayName?.trim() || r.peerLabel?.trim() || r.peerId;
      const gradient = getPeerGradient(r.peerId || r.peerLabel || r.provider || r.serviceId);
      const letter = (label || '?').charAt(0).toUpperCase();
      seen.set(r.peerId, {
        opt: { peerId: r.peerId, label, letter, gradient, knownProxy: getKnownProxy(r.sellerContract) },
        score: rowReputationScore(r),
        label,
      });
    }
    return Array.from(seen.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.label.localeCompare(b.label);
      })
      .map((e) => e.opt);
  }, [rows]);

  const filteredRows = useMemo(
    () => applyFilters(rows, {
      search, categorySet, peerSet, maxInputPrice, maxOutputPrice, minStakeUsdc,
      minReputationScore,
    }),
    [rows, search, categorySet, peerSet, maxInputPrice, maxOutputPrice, minStakeUsdc,
      minReputationScore],
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
    minStakeUsdc,
    minReputationScore,
    sortKey,

    sortedRows,
    availableCategories,
    availablePeers,

    setSearch,
    toggleCategory,
    togglePeer,
    setMaxInputPrice,
    setMaxOutputPrice,
    setMinStakeUsdc,
    setMinReputationScore,
    setSortKey,
    resetAll,
  };
}
