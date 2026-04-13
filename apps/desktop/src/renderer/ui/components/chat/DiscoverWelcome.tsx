import { useState, useMemo, useCallback, useEffect } from 'react';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import type { ChatServiceOptionEntry, DiscoverRow } from '../../../core/state';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useDiscoverFilters } from '../../hooks/useDiscoverFilters';
import type { DiscoverSortKey } from './discover-filter-util';
import { DiscoverFilters } from './DiscoverFilters';
import { stringHash, PEER_GRADIENTS, getPeerDisplayName, formatPerMillionPrice } from '../../../core/peer-utils';
import styles from './DiscoverWelcome.module.scss';

const SORT_OPTIONS: Array<{ key: DiscoverSortKey; label: string }> = [
  { key: 'recentlyUsed',    label: 'Recently used' },
  { key: 'serviceAsc',      label: 'Name A–Z' },
  { key: 'serviceDesc',     label: 'Name Z–A' },
  { key: 'inputAsc',        label: 'Cheapest input' },
  { key: 'inputDesc',       label: 'Priciest input' },
  { key: 'outputAsc',       label: 'Cheapest output' },
  { key: 'outputDesc',      label: 'Priciest output' },
  { key: 'cachedInputAsc',  label: 'Cheapest cached input' },
  { key: 'cachedInputDesc', label: 'Priciest cached input' },
  { key: 'stakeDesc',       label: 'Most staked' },
  { key: 'volumeDesc',      label: 'Most volume' },
  { key: 'lastSettledDesc', label: 'Recently settled' },
  { key: 'stakedAtDesc',    label: 'Newest validators' },
  { key: 'stakedAtAsc',     label: 'Oldest validators' },
];

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

/* ── Service-name → visual gradient (for provider avatars) ─────────── */

const SERVICE_GRADIENTS: Record<string, string> = {
  llama:     'linear-gradient(180deg, #0668E1, #0553B7)',
  deepseek:  'linear-gradient(180deg, #536DFE, #304FFE)',
  kimi:      'linear-gradient(180deg, #0D0D18, #252545)',
  qwen:      'linear-gradient(180deg, #615CED, #4440C4)',
  flux:      'linear-gradient(180deg, #1C1C1E, #3A3A3C)',
  mistral:   'linear-gradient(180deg, #FF7000, #E05800)',
  claude:    'linear-gradient(180deg, #DA6B47, #C45D3D)',
  gpt:       'linear-gradient(180deg, #0FA37F, #0D8C6D)',
  openai:    'linear-gradient(180deg, #0FA37F, #0D8C6D)',
  gemini:    'linear-gradient(180deg, #4285F4, #1A73E8)',
  phi:       'linear-gradient(180deg, #0078D4, #005A9E)',
  command:   'linear-gradient(180deg, #39594D, #2A4A3D)',
  glm:       'linear-gradient(180deg, #00B4D8, #0096C7)',
  minimax:   'linear-gradient(180deg, #E040FB, #AA00FF)',
  yi:        'linear-gradient(180deg, #1A1A2E, #16213E)',
  gemma:     'linear-gradient(180deg, #4285F4, #1A73E8)',
  community: 'linear-gradient(180deg, #1FD87A, #17C46E)',
};

function getGradient(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, gradient] of Object.entries(SERVICE_GRADIENTS)) {
    if (lower.includes(key)) return gradient;
  }
  return PEER_GRADIENTS[stringHash(lower) % PEER_GRADIENTS.length];
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
  if (categories.length > 0) return `${categories.join(' & ')} service powered by ${prov}.`;
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
      gradient: getGradient(opt.peerLabel || opt.provider || opt.id),
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
      gradient: getGradient(peerLabel || row.provider || row.serviceId),
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
        <div className={styles.cardTags}>
          <Skeleton width={52} height={18} borderRadius={24} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
          <Skeleton width={42} height={18} borderRadius={24} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        </div>
        <Skeleton width="65%" height={16} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <Skeleton width="90%" height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <Skeleton width="55%" height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </div>
      <div className={styles.cardFooter}>
        <Skeleton width={90} height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </div>
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

const PAGE_SIZE = 9;

export function DiscoverWelcome({ serviceOptions, onStartChatting }: DiscoverWelcomeProps) {
  const snap = useUiSnapshot();
  const rows = snap.discoverRows;

  const [page, setPage] = useState(1);
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
    filterState.priceBucket,
    filterState.cachedOnly,
    filterState.chattedOnly,
    filterState.minStakeUsdc,
    filterState.sortKey,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const paged = filtered.slice(pageStart, pageStart + PAGE_SIZE);
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
            </button>
            <select
              className={styles.sortSelect}
              value={filterState.sortKey}
              onChange={(e) => filterState.setSortKey(e.target.value as DiscoverSortKey)}
              aria-label="Sort services"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </div>
          {!hasNetworkData && (
            <div className={styles.loadingHint}>
              Connecting to network...
            </div>
          )}

          <div className={styles.resultsArea}>
            {!hasNetworkData ? (
              <div className={styles.cardGrid}>
                {Array.from({ length: 9 }, (_, i) => (
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
              <div className={styles.emptyFilter}>No services match this filter.</div>
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
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
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
      {pages.map((n) => (
        <button
          key={n}
          className={`${styles.pageBtn}${n === page ? ` ${styles.pageBtnActive}` : ''}`}
          onClick={() => onPageChange(n)}
          aria-current={n === page ? 'page' : undefined}
        >
          {n}
        </button>
      ))}
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

  return (
    <div
      className={styles.card}
      onClick={() => onClick(item.value, item.peerId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(item.value, item.peerId); } }}
    >
      <div className={styles.cardBody}>
        <div className={styles.cardTags}>
          {item.tags.map((t) => (
            <span key={t} className={styles.tag}>{t}</span>
          ))}
        </div>
        <div className={styles.cardName}>{item.displayName}</div>
        <div className={styles.cardDesc}>{item.description}</div>
        <div className={styles.cardPricing}>
          {isFree ? (
            <span>Free</span>
          ) : hasInput && hasOutput ? (
            <>
              <span>{formatPerMillionPrice(item.inputUsdPerMillion!)} input tokens</span>
              <span className={styles.pricingDot} />
              <span>{formatPerMillionPrice(item.outputUsdPerMillion!)} output tokens</span>
            </>
          ) : hasInput ? (
            <span>{formatPerMillionPrice(item.inputUsdPerMillion!)} input tokens</span>
          ) : hasOutput ? (
            <span>{formatPerMillionPrice(item.outputUsdPerMillion!)} output tokens</span>
          ) : null}
        </div>
      </div>

      <div className={styles.cardFooter}>
        <div className={styles.cardFooterTop}>
          <div className={styles.cardProvider}>
            <span className={styles.cardProviderBy}>By</span>
            <ProviderAvatar name={providerName} gradient={item.gradient} />
            <span className={styles.cardProviderName}>{providerName}</span>
          </div>
          {item.providerCount > 1 && (
            <span className={styles.cardProviderCount}>
              {item.providerCount} providers
            </span>
          )}
        </div>
        <div className={styles.cardStats}>
          <span>{item.channelCount} channel{item.channelCount === 1 ? '' : 's'}</span>
          <span className={styles.statsDot} />
          <span>{formatCompact(item.lifetimeRequests)} request{item.lifetimeRequests === 1 ? '' : 's'}</span>
          <span className={styles.statsDot} />
          <span>{formatCompact(item.lifetimeTokens)} token{item.lifetimeTokens === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}
