import { useState, useMemo, useCallback, useEffect } from 'react';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import { HugeiconsIcon } from '@hugeicons/react';
import { Search01Icon, FilterResetIcon } from '@hugeicons/core-free-icons';
import type { ChatServiceOptionEntry, DiscoverRow } from '../../../core/state';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useDiscoverFilters, type DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import {
  MAX_INPUT_PRICE_SLIDER_USD,
  MAX_OUTPUT_PRICE_SLIDER_USD,
  DEFAULT_MIN_ON_CHAIN_CHANNELS,
  formatCategoryLabel,
} from './discover-filter-util';
import { DiscoverFilters } from './DiscoverFilters';
import { DiscoverInlineCategoryFilter } from './DiscoverInlineCategoryFilter';
import { DiscoverInlinePriceFilter } from './DiscoverInlinePriceFilter';
import { DiscoverInlineSortFilter } from './DiscoverInlineSortFilter';
import { getPeerGradient, getPeerDisplayName, formatPerMillionPrice } from '../../../core/peer-utils';
import { getCategoryIcon } from './discover-category-icons';
import { ProviderLogo } from './ProviderLogo';
import styles from './DiscoverWelcome.module.scss';

/**
 * Cap the visible tag count on Discover cards to avoid wrapping onto a
 * second line when a service has 5+ categories (e.g. anon + chat + coding +
 * reasoning + multimodal). Overflow is shown as a single “+N” pill whose
 * tooltip lists the hidden tags.
 */
const MAX_VISIBLE_CARD_TAGS = 3;

/** Tag rendered with a special accent (privacy property, not a capability). */
const ACCENT_TAGS = new Set(['anon']);

/* ── Card data type ──────────────────────────────────────────────────── */

type CardItem = {
  name: string;
  displayName: string;
  peerLabel: string;
  peerId: string;
  value: string;
  provider: string;
  providerCount: number;
  tags: string[];
  gradient: string;
  description: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  channelCount: number;       // on-chain, from AntseedChannels.getAgentStats
  lifetimeRequests: number;   // network-wide (mainnet) or local buyer total (fallback)
  lifetimeTokens: number;     // network-wide (mainnet) or local buyer total (fallback)
};

/* ── Normalize service name for display (dashes → spaces) ─────────────── */

function normalizeServiceName(name: string): string {
  return name.replace(/[-_]+/g, ' ');
}

/* ── Generate description from service name ──────────────────────────── */

function generateDescription(serviceId: string, categories: string[], provider: string): string {
  const lower = serviceId.toLowerCase();
  const prov = provider || 'a network peer';

  if (lower.includes('claude')) return `Access to Anthropic's Claude model. Powered by ${prov}.`;
  if (lower.includes('gpt') || lower.includes('openai')) return `OpenAI model access through ${prov}.`;
  if (lower.includes('llama')) return `Meta's Llama open-weight model. Hosted by ${prov}.`;
  if (lower.includes('deepseek')) return `DeepSeek reasoning model. Served by ${prov}.`;
  if (lower.includes('mistral')) return `Mistral's flagship model. Strong multilingual and instruction following.`;
  if (lower.includes('kimi')) return `Moonshot's Kimi reasoning model. High-performance math and code.`;
  if (lower.includes('qwen')) return `Alibaba's Qwen model series. Multilingual and versatile.`;
  if (lower.includes('gemini') || lower.includes('gemma')) return `Google's model. Powered by ${prov}.`;
  if (lower.includes('flux') || lower.includes('sdxl')) return `Image generation model. Served by ${prov}.`;
  if (categories.length > 0) return `${categories.map(formatCategoryLabel).join(' & ')} service powered by ${prov}.`;
  return `AI service powered by ${prov}.`;
}

/* ── Build cards from network service options ──────────────────────────── */

function buildCards(options: ChatServiceOptionEntry[]): CardItem[] {
  return options.map((opt) => {
    const baseTags = opt.categories;
    const tags = baseTags.some((t) => t.toLowerCase() === 'anon')
      ? baseTags
      : ['anon', ...baseTags];
    const rawName = opt.label || opt.id;
    return {
      name: rawName,
      displayName: normalizeServiceName(rawName),
      peerLabel: opt.peerLabel || '',
      peerId: opt.peerId || '',
      value: opt.value,
      provider: opt.provider,
      providerCount: opt.count,
      tags,
      gradient: getPeerGradient(opt.peerId || opt.peerLabel || opt.provider || opt.id),
      description: opt.description || generateDescription(opt.id, opt.categories, opt.peerLabel || opt.provider),
      inputUsdPerMillion: opt.inputUsdPerMillion,
      outputUsdPerMillion: opt.outputUsdPerMillion,
      channelCount: 0,
      lifetimeRequests: 0,
      lifetimeTokens: 0,
    };
  });
}

/* ── Build cards directly from rows (carries lifetime stats) ─────────── */

function pickRequests(row: DiscoverRow): number {
  if (row.networkRequests !== null) {
    const n = Number(row.networkRequests);
    if (Number.isFinite(n)) return n;
  }
  return row.lifetimeRequests;
}

function pickTokens(row: DiscoverRow): number {
  if (row.networkInputTokens !== null || row.networkOutputTokens !== null) {
    const inp = row.networkInputTokens !== null ? Number(row.networkInputTokens) : 0;
    const out = row.networkOutputTokens !== null ? Number(row.networkOutputTokens) : 0;
    if (Number.isFinite(inp) && Number.isFinite(out)) return inp + out;
  }
  return row.lifetimeInputTokens + row.lifetimeOutputTokens;
}

function buildCardsFromRows(rows: DiscoverRow[]): CardItem[] {
  const seen = new Set<string>();
  const out: CardItem[] = [];
  for (const row of rows) {
    const key = `${row.provider}\u0001${row.serviceId}\u0001${row.peerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const baseTags = row.categories;
    const tags = baseTags.some((t) => t.toLowerCase() === 'anon')
      ? baseTags
      : ['anon', ...baseTags];
    const rawName = row.serviceLabel || row.serviceId;
    const peerLabel = row.peerLabel || '';
    out.push({
      name: rawName,
      displayName: normalizeServiceName(rawName),
      peerLabel,
      peerId: row.peerId,
      value: row.selectionValue,
      provider: row.provider,
      providerCount: 1,
      tags,
      gradient: getPeerGradient(row.peerId || peerLabel || row.provider || row.serviceId),
      description: generateDescription(row.serviceId, row.categories, peerLabel || row.provider),
      inputUsdPerMillion: row.inputUsdPerMillion,
      outputUsdPerMillion: row.outputUsdPerMillion,
      channelCount: row.onChainActiveChannelCount,
      lifetimeRequests: pickRequests(row),
      lifetimeTokens: pickTokens(row),
    });
  }
  return out;
}

/* ── Compact number formatter (12.3k / 1.2M) ─────────────────────────── */

function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/* ── Search matcher ──────────────────────────────────────────────────── */

function matchesSearch(item: CardItem, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.name.toLowerCase().includes(q)) return true;
  if (item.displayName.toLowerCase().includes(q)) return true;
  if (item.peerLabel.toLowerCase().includes(q)) return true;
  if (item.tags.some((t) => t.toLowerCase().includes(q))) return true;
  return false;
}

/* ── Skeleton card ───────────────────────────────────────────────────── */

const skeletonBaseColor = 'rgba(0,0,0,0.04)';
const skeletonHighlightColor = 'rgba(0,0,0,0.07)';

function SkeletonCard() {
  return (
    <div className={styles.card}>
      <div className={styles.cardBody}>
        <Skeleton width="60%" height={18} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <div className={styles.cardChips}>
          <Skeleton width={56} height={20} borderRadius={999} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
          <Skeleton width={64} height={20} borderRadius={999} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        </div>
      </div>
      <div className={styles.cardPricing}>
        <Skeleton width={80} height={18} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <Skeleton width={80} height={18} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </div>
      <footer className={styles.cardFooter}>
        <div className={styles.cardAttribution}>
          <Skeleton width={18} height={18} circle baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
          <Skeleton width={90} height={11} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        </div>
        <Skeleton width={90} height={11} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </footer>
    </div>
  );
}

/* ── Provider avatar ─────────────────────────────────────────────────── */

function ProviderAvatar({ name, gradient }: { name: string; gradient: string }) {
  const letter = (name || '?').charAt(0).toUpperCase();
  return (
    <span className={styles.providerAvatar} style={{ background: gradient }}>
      {letter}
    </span>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

type DiscoverWelcomeProps = {
  serviceOptions: ChatServiceOptionEntry[];
  onStartChatting: (serviceValue: string, peerId?: string) => void;
};

const MIN_CARD_WIDTH_PX = 320;
const GRID_GAP_PX = 12;
const CARD_ESTIMATED_HEIGHT_PX = 208;
const DEFAULT_PAGE_SIZE = 9;

type PaginationToken = number | 'ellipsis';

function estimatePageSize(): number {
  if (typeof window === 'undefined') return DEFAULT_PAGE_SIZE;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let columns = 1;
  if (viewportWidth > 520) columns = 2;
  if (viewportWidth > 780) {
    const estimatedColumns = Math.floor((viewportWidth + GRID_GAP_PX) / (MIN_CARD_WIDTH_PX + GRID_GAP_PX));
    columns = Math.max(3, estimatedColumns);
  }

  const usableHeight = Math.max(360, viewportHeight - 320);
  const rows = Math.max(1, Math.floor((usableHeight + GRID_GAP_PX) / (CARD_ESTIMATED_HEIGHT_PX + GRID_GAP_PX)));
  const estimatedPageSize = Math.max(columns, columns * rows);

  if (viewportWidth > 780) {
    return Math.max(DEFAULT_PAGE_SIZE, estimatedPageSize);
  }

  return estimatedPageSize;
}

function buildPaginationTokens(page: number, totalPages: number): PaginationToken[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (page <= 3) {
    return [1, 2, 3, 'ellipsis', totalPages - 1, totalPages];
  }

  if (page >= totalPages - 2) {
    return [1, 2, 'ellipsis', totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages];
}

export function DiscoverWelcome({ serviceOptions, onStartChatting }: DiscoverWelcomeProps) {
  const snap = useUiSnapshot();
  const rows = snap.discoverRows;

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => estimatePageSize());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerClosing, setDrawerClosing] = useState(false);

  const closeDrawer = useCallback(() => {
    setDrawerClosing(true);
    window.setTimeout(() => {
      setDrawerOpen(false);
      setDrawerClosing(false);
    }, 200);
  }, []);

  const filterState = useDiscoverFilters(rows);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const updatePageSize = () => {
      setPageSize((prev) => {
        const next = estimatePageSize();
        return prev === next ? prev : next;
      });
    };

    updatePageSize();
    window.addEventListener('resize', updatePageSize);
    return () => window.removeEventListener('resize', updatePageSize);
  }, []);

  const hasActiveFilters =
    filterState.categorySet.size > 0 ||
    filterState.peerSet.size > 0 ||
    filterState.maxInputPrice < MAX_INPUT_PRICE_SLIDER_USD ||
    filterState.maxOutputPrice < MAX_OUTPUT_PRICE_SLIDER_USD ||
    filterState.chattedOnly ||
    filterState.minStakeUsdc > 0 ||
    filterState.lastSeenWindow !== 'any' ||
    filterState.lastSettledWindow !== 'any' ||
    filterState.minOnChainChannels !== DEFAULT_MIN_ON_CHAIN_CHANNELS;

  const hasNetworkData = serviceOptions.length > 0 || rows.length > 0;
  const cards = useMemo(() => {
    if (rows.length > 0) {
      return buildCardsFromRows(filterState.sortedRows);
    }
    return serviceOptions.length > 0 ? buildCards(serviceOptions) : [];
  }, [rows.length, filterState.sortedRows, serviceOptions]);

  const filtered = useMemo(
    () => cards.filter((c) => matchesSearch(c, filterState.search)),
    [cards, filterState.search],
  );

  useEffect(() => { setPage(1); }, [
    filterState.search,
    filterState.categorySet,
    filterState.peerSet,
    filterState.maxInputPrice,
    filterState.maxOutputPrice,
    filterState.chattedOnly,
    filterState.minStakeUsdc,
    filterState.lastSeenWindow,
    filterState.lastSettledWindow,
    filterState.minOnChainChannels,
    filterState.sortKey,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const paged = filtered.slice(pageStart, pageStart + pageSize);
  const rangeStart = filtered.length === 0 ? 0 : pageStart + 1;
  const rangeEnd = pageStart + paged.length;
  const statusText = `${rangeStart}-${rangeEnd} of ${filtered.length} total service${filtered.length === 1 ? '' : 's'}`;

  const handleClick = useCallback(
    (value: string, peerId: string) => {
      if (value) onStartChatting(value, peerId || undefined);
    },
    [onStartChatting],
  );

  return (
    <div className={styles.discover}>
      <div className={styles.cardsScroll}>
        <div className={styles.cardsInner}>

          <div className={styles.header}>
            <h1 className={styles.heading}>
              The open market for <span className={styles.headingAccent}>AI</span> inference. No gatekeepers.
            </h1>
            <p className={styles.subtitle}>
              Pick a service to start chatting and building. Filter by what you need.
              Everything is anonymous — no account required.
            </p>
          </div>

          <div className={styles.controlsRow}>
            <div className={styles.searchBox}>
              <svg
                className={styles.searchIcon}
                width="14" height="14" viewBox="0 0 16 16" fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <input
                type="text"
                className={styles.searchInput}
                value={filterState.search}
                onChange={(e) => filterState.setSearch(e.target.value)}
                placeholder="Search services, peers, categories…"
                aria-label="Search services"
              />
            </div>
            <button
              type="button"
              className={`${styles.filterTrigger}${drawerOpen && !drawerClosing ? ` ${styles.filterTriggerActive}` : ''}`}
              onClick={() => {
                if (drawerOpen && !drawerClosing) closeDrawer();
                else setDrawerOpen(true);
              }}
              aria-expanded={drawerOpen && !drawerClosing}
              aria-label={drawerOpen && !drawerClosing ? 'Close filters' : 'Open filters'}
              title="Filters"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M2.5 5.83325H5M2.5 14.1666H7.5M15 14.1666H17.5M12.5 5.83325H17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M5 5.83325C5 5.05659 5 4.66825 5.12667 4.36242C5.21043 4.16007 5.33325 3.97621 5.4881 3.82135C5.64296 3.6665 5.82682 3.54368 6.02917 3.45992C6.335 3.33325 6.72333 3.33325 7.5 3.33325C8.27667 3.33325 8.665 3.33325 8.97083 3.45992C9.17318 3.54368 9.35704 3.6665 9.5119 3.82135C9.66675 3.97621 9.78957 4.16007 9.87333 4.36242C10 4.66825 10 5.05659 10 5.83325C10 6.60992 10 6.99825 9.87333 7.30409C9.78957 7.50643 9.66675 7.69029 9.5119 7.84515C9.35704 8.00001 9.17318 8.12282 8.97083 8.20658C8.665 8.33325 8.27667 8.33325 7.5 8.33325C6.72333 8.33325 6.335 8.33325 6.02917 8.20658C5.82682 8.12282 5.64296 8.00001 5.4881 7.84515C5.33325 7.69029 5.21043 7.50643 5.12667 7.30409C5 6.99825 5 6.60992 5 5.83325ZM10 14.1666C10 13.3899 10 13.0016 10.1267 12.6958C10.2104 12.4934 10.3332 12.3095 10.4881 12.1547C10.643 11.9998 10.8268 11.877 11.0292 11.7933C11.335 11.6666 11.7233 11.6666 12.5 11.6666C13.2767 11.6666 13.665 11.6666 13.9708 11.7933C14.1732 11.877 14.357 11.9998 14.5119 12.1547C14.6668 12.3095 14.7896 12.4934 14.8733 12.6958C15 13.0016 15 13.3899 15 14.1666C15 14.9433 15 15.3316 14.8733 15.6374C14.7896 15.8398 14.6668 16.0236 14.5119 16.1785C14.357 16.3333 14.1732 16.4562 13.9708 16.5399C13.665 16.6666 13.2767 16.6666 12.5 16.6666C11.7233 16.6666 11.335 16.6666 11.0292 16.5399C10.8268 16.4562 10.643 16.3333 10.4881 16.1785C10.3332 16.0236 10.2104 15.8398 10.1267 15.6374C10 15.3316 10 14.9433 10 14.1666Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              {hasActiveFilters && <span className={styles.filterTriggerDot} aria-hidden="true" />}
            </button>
            <DiscoverInlineCategoryFilter filters={filterState} />
            <DiscoverInlinePriceFilter filters={filterState} />
            <DiscoverInlineSortFilter filters={filterState} />
          </div>
          {!hasNetworkData && (
            <div className={styles.loadingHint}>
              Connecting to network...
            </div>
          )}

          <div className={styles.resultsArea}>
            {!hasNetworkData ? (
              <div className={styles.cardGrid}>
                {Array.from({ length: pageSize }, (_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            ) : filtered.length > 0 ? (
              <div className={styles.cardGrid}>
                {paged.map((item) => (
                  <Card
                    key={item.value || item.name}
                    item={item}
                    onClick={handleClick}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                search={filterState.search}
                hasActiveFilters={hasActiveFilters}
                filterState={filterState}
              />
            )}
            {hasNetworkData && filtered.length > 0 && (
              <div className={styles.paginationBar}>
                <span className={styles.statusText}>{statusText}</span>
                {totalPages > 1 && (
                  <Pagination
                    page={currentPage}
                    totalPages={totalPages}
                    onPageChange={setPage}
                  />
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      {drawerOpen && (
        <aside
          className={`${styles.drawer}${drawerClosing ? ` ${styles.drawerClosing}` : ''}`}
          role="dialog"
          aria-label="Filters"
        >
          <div className={styles.drawerHeader}>
            <span className={styles.drawerTitle}>Filters</span>
            <button
              type="button"
              className={styles.drawerClose}
              onClick={closeDrawer}
              aria-label="Close filters"
            >
              ×
            </button>
          </div>
          <div className={styles.drawerBody}>
            <DiscoverFilters filters={filterState} />
          </div>
        </aside>
      )}
    </div>
  );
}

/* ── Pagination ──────────────────────────────────────────────────────── */

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  const tokens = buildPaginationTokens(page, totalPages);
  return (
    <nav className={styles.pagination} aria-label="Pagination">
      <button
        className={styles.pageBtn}
        disabled={page === 1}
        onClick={() => onPageChange(Math.max(1, page - 1))}
        aria-label="Previous page"
      >
        ‹
      </button>
      {tokens.map((token, index) => {
        if (token === 'ellipsis') {
          return (
            <span key={`ellipsis-${index}`} className={styles.pageEllipsis} aria-hidden="true">
              …
            </span>
          );
        }

        return (
          <button
            key={token}
            className={`${styles.pageBtn}${token === page ? ` ${styles.pageBtnActive}` : ''}`}
            onClick={() => onPageChange(token)}
            aria-current={token === page ? 'page' : undefined}
          >
            {token}
          </button>
        );
      })}
      <button
        className={styles.pageBtn}
        disabled={page === totalPages}
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        aria-label="Next page"
      >
        ›
      </button>
    </nav>
  );
}

/* ── Card ─────────────────────────────────────────────────────────────── */

function Card({
  item,
  onClick,
}: {
  item: CardItem;
  onClick: (v: string, peerId: string) => void;
}) {
  const providerName = (item.peerLabel ? getPeerDisplayName(item.peerLabel) : '') || item.provider || 'Peer';
  const hasInput = item.inputUsdPerMillion != null;
  const hasOutput = item.outputUsdPerMillion != null;
  const isFree = hasInput && hasOutput && item.inputUsdPerMillion === 0 && item.outputUsdPerMillion === 0;
  // Capabilities = tags minus "anon" (which is implicit, not surfaced as a pill).
  const capabilityTags = item.tags.filter((t) => !ACCENT_TAGS.has(t.toLowerCase()));
  const visibleTags = capabilityTags.slice(0, MAX_VISIBLE_CARD_TAGS);
  const overflowTags = capabilityTags.slice(MAX_VISIBLE_CARD_TAGS);

  return (
    <div
      className={styles.card}
      onClick={() => onClick(item.value, item.peerId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(item.value, item.peerId); } }}
    >
      <div className={styles.cardBody}>
        <h3 className={styles.cardName}>
          <ProviderLogo modelName={item.name} className={styles.modelLogo} />
          <span className={styles.cardNameText}>{item.displayName}</span>
        </h3>

        {item.description && (
          <p className={styles.cardDesc}>{item.description}</p>
        )}

        {capabilityTags.length > 0 && (
          <div className={styles.cardChips}>
            {visibleTags.map((t) => (
              <span key={t} className={styles.chip}>
                <HugeiconsIcon
                  icon={getCategoryIcon(t)}
                  size={11}
                  strokeWidth={1.6}
                  className={styles.chipIcon}
                />
                {formatCategoryLabel(t)}
              </span>
            ))}
            {overflowTags.length > 0 && (
              <span
                className={styles.chipMore}
                title={overflowTags.map(formatCategoryLabel).join(', ')}
                aria-label={`${overflowTags.length} more categories: ${overflowTags.map(formatCategoryLabel).join(', ')}`}
              >
                +{overflowTags.length}
              </span>
            )}
          </div>
        )}
      </div>

      <div className={styles.cardPricing}>
        {isFree ? (
          <span className={`${styles.pricingValue} ${styles.pricingValueFree}`}>Free</span>
        ) : (hasInput || hasOutput) ? (
          <>
            {hasInput && (
              <span className={styles.pricingCol}>
                <span className={styles.pricingValue}>{formatPerMillionPrice(item.inputUsdPerMillion!)}</span>
                <span className={styles.pricingLabel}>in</span>
              </span>
            )}
            {hasOutput && (
              <span className={styles.pricingCol}>
                <span className={styles.pricingValue}>{formatPerMillionPrice(item.outputUsdPerMillion!)}</span>
                <span className={styles.pricingLabel}>out</span>
              </span>
            )}
          </>
        ) : (
          <span className={styles.pricingMeta}>Pricing on request</span>
        )}
      </div>

      <footer className={styles.cardFooter}>
        <div className={styles.cardAttribution}>
          <ProviderAvatar name={providerName} gradient={item.gradient} />
          <span className={styles.cardAttributionText}>
            by <strong>{providerName}</strong>
            {item.providerCount > 1 && (
              <span className={styles.cardProviderCount}> · {item.providerCount} peers</span>
            )}
          </span>
        </div>
        <div className={styles.cardStats}>
          <span className={styles.statItem}>
            <strong>{formatCompact(item.channelCount)}</strong> ch
          </span>
          <span className={styles.statsDot} aria-hidden="true" />
          <span className={styles.statItem}>
            <strong>{formatCompact(item.lifetimeRequests)}</strong> req
          </span>
          <span className={styles.statsDot} aria-hidden="true" />
          <span className={styles.statItem}>
            <strong>{formatCompact(item.lifetimeTokens)}</strong> tok
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────── */

const TIME_WINDOW_LABELS: Record<string, string> = {
  today: 'Last 24 h',
  week: 'Last 7 days',
  month: 'Last 30 days',
};

type FilterChip = { key: string; label: string; onClear: () => void };

function buildFilterChips(filterState: DiscoverFilterState): FilterChip[] {
  const chips: FilterChip[] = [];

  filterState.categorySet.forEach((cat) => {
    chips.push({
      key: `cat-${cat}`,
      label: formatCategoryLabel(cat),
      onClear: () => filterState.toggleCategory(cat),
    });
  });

  filterState.peerSet.forEach((peerId) => {
    const peer = filterState.availablePeers.find((p) => p.peerId === peerId);
    chips.push({
      key: `peer-${peerId}`,
      label: peer?.label ?? peerId,
      onClear: () => filterState.togglePeer(peerId),
    });
  });

  if (filterState.maxInputPrice < MAX_INPUT_PRICE_SLIDER_USD) {
    chips.push({
      key: 'max-input',
      label: `Input ≤ $${filterState.maxInputPrice.toFixed(filterState.maxInputPrice < 1 ? 2 : 1)}`,
      onClear: () => filterState.setMaxInputPrice(MAX_INPUT_PRICE_SLIDER_USD),
    });
  }

  if (filterState.maxOutputPrice < MAX_OUTPUT_PRICE_SLIDER_USD) {
    chips.push({
      key: 'max-output',
      label: `Output ≤ $${filterState.maxOutputPrice.toFixed(filterState.maxOutputPrice < 1 ? 2 : 1)}`,
      onClear: () => filterState.setMaxOutputPrice(MAX_OUTPUT_PRICE_SLIDER_USD),
    });
  }

  if (filterState.chattedOnly) {
    chips.push({
      key: 'chatted-only',
      label: 'Chatted before',
      onClear: () => filterState.setChattedOnly(false),
    });
  }

  if (filterState.minStakeUsdc > 0) {
    chips.push({
      key: 'min-stake',
      label: `Stake ≥ $${filterState.minStakeUsdc}`,
      onClear: () => filterState.setMinStakeUsdc(0),
    });
  }

  if (filterState.lastSeenWindow !== 'any') {
    chips.push({
      key: 'last-seen',
      label: `Seen · ${TIME_WINDOW_LABELS[filterState.lastSeenWindow] ?? filterState.lastSeenWindow}`,
      onClear: () => filterState.setLastSeenWindow('any'),
    });
  }

  if (filterState.lastSettledWindow !== 'any') {
    chips.push({
      key: 'last-settled',
      label: `Settled · ${TIME_WINDOW_LABELS[filterState.lastSettledWindow] ?? filterState.lastSettledWindow}`,
      onClear: () => filterState.setLastSettledWindow('any'),
    });
  }

  if (filterState.minOnChainChannels !== DEFAULT_MIN_ON_CHAIN_CHANNELS) {
    chips.push({
      key: 'min-channels',
      label: `≥ ${filterState.minOnChainChannels} channels`,
      onClear: () => filterState.setMinOnChainChannels(DEFAULT_MIN_ON_CHAIN_CHANNELS),
    });
  }

  return chips;
}

function EmptyState({
  search,
  hasActiveFilters,
  filterState,
}: {
  search: string;
  hasActiveFilters: boolean;
  filterState: DiscoverFilterState;
}) {
  const hasSearch = search.trim().length > 0;
  const canReset = hasSearch || hasActiveFilters;
  const chips = hasActiveFilters ? buildFilterChips(filterState) : [];

  return (
    <div className={styles.emptyState} role="status" aria-live="polite">
      <div className={styles.emptyIcon} aria-hidden="true">
        <HugeiconsIcon icon={Search01Icon} size={28} strokeWidth={1.5} />
      </div>

      <h2 className={styles.emptyTitle}>No matches in the network</h2>
      <p className={styles.emptyText}>Try a broader search or different filters</p>

      {chips.length > 0 && (
        <div className={styles.emptyChips}>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={styles.emptyChip}
              onClick={chip.onClear}
              aria-label={`Remove filter: ${chip.label}`}
              title={`Remove “${chip.label}”`}
            >
              <span className={styles.emptyChipLabel}>{chip.label}</span>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          ))}
        </div>
      )}

      {canReset && (
        <div className={styles.emptyActions}>
          <button
            type="button"
            className={styles.emptyPrimary}
            onClick={() => filterState.resetAll()}
          >
            <HugeiconsIcon icon={FilterResetIcon} size={14} strokeWidth={1.5} />
            Show all services
          </button>

          {hasSearch && hasActiveFilters && (
            <div className={styles.emptyLinks}>
              <button
                type="button"
                className={styles.emptyLink}
                onClick={() => filterState.setSearch('')}
              >
                Clear search only
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
