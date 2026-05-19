import {useEffect, useState, useMemo, useRef} from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './network.module.css';

/* ── API types ──────────────────────────────────────────────────────── */

const STATS_URL     = 'https://network.antseed.com/stats';
const DEV_STATS_URL = 'http://localhost:4000/stats';

interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}
interface ProviderAnnouncement {
  provider: string;
  services: string[];
  defaultPricing: TokenPricing;
  servicePricing?: Record<string, TokenPricing>;
  serviceCategories?: Record<string, string[]>;
  maxConcurrency: number;
  currentLoad: number;
}
interface OnChainStats {
  agentId: number;
  totalRequests: string;
  totalInputTokens: string;
  totalOutputTokens: string;
  settlementCount: number;
  uniqueBuyers: number;
  uniqueChannels: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastUpdatedAt: number;
}
interface PeerMetadata {
  peerId: string;
  displayName?: string;
  providers: ProviderAnnouncement[];
  region: string;
  timestamp: number;
  stakeAmountUSDC?: number;
  trustScore?: number;
  onChainReputation?: number;
  onChainSessionCount?: number;
  onChainChannelCount?: number;
  onChainStats?: OnChainStats;
}
interface StatsResponse { peers: PeerMetadata[]; updatedAt: string; }

/* ── Model metadata ──────────────────────────────────────────────────── */

interface ModelMeta { displayName: string; provider: string; contextWindow: string; tags: string[]; }

const MODEL_META: Record<string, ModelMeta> = {
  'claude-opus-4-6':   {displayName:'Claude Opus 4.6',   provider:'Anthropic', contextWindow:'200K', tags:['chat','code','reasoning']},
  'claude-sonnet-4-6': {displayName:'Claude Sonnet 4.6', provider:'Anthropic', contextWindow:'200K', tags:['chat','code','fast']},
  'claude-haiku-4-5':  {displayName:'Claude Haiku 4.5',  provider:'Anthropic', contextWindow:'200K', tags:['chat','fast','cheap']},
  'gpt-4.1':           {displayName:'GPT-4.1',           provider:'OpenAI',   contextWindow:'1M',   tags:['chat','code','reasoning']},
  'gpt-4.1-mini':      {displayName:'GPT-4.1 Mini',      provider:'OpenAI',   contextWindow:'1M',   tags:['chat','fast','cheap']},
  'gpt-4.1-nano':      {displayName:'GPT-4.1 Nano',      provider:'OpenAI',   contextWindow:'1M',   tags:['chat','fast','cheap']},
  'o3':                {displayName:'o3',                 provider:'OpenAI',   contextWindow:'200K', tags:['reasoning','code']},
  'o4-mini':           {displayName:'o4-mini',            provider:'OpenAI',   contextWindow:'200K', tags:['reasoning','fast']},
  'gemini-2.5-pro':    {displayName:'Gemini 2.5 Pro',    provider:'Google',   contextWindow:'1M',   tags:['chat','code','reasoning']},
  'gemini-2.5-flash':  {displayName:'Gemini 2.5 Flash',  provider:'Google',   contextWindow:'1M',   tags:['chat','fast','cheap']},
  'llama-4-maverick':  {displayName:'Llama 4 Maverick',  provider:'Meta',     contextWindow:'1M',   tags:['chat','code','open-source']},
  'llama-4-scout':     {displayName:'Llama 4 Scout',     provider:'Meta',     contextWindow:'512K', tags:['chat','fast','open-source']},
  'deepseek-r1':       {displayName:'DeepSeek R1',        provider:'DeepSeek', contextWindow:'128K', tags:['reasoning','code','open-source']},
  'deepseek-v3':       {displayName:'DeepSeek V3',        provider:'DeepSeek', contextWindow:'128K', tags:['chat','code','open-source']},
  'mistral-large':     {displayName:'Mistral Large',      provider:'Mistral',  contextWindow:'128K', tags:['chat','code','reasoning']},
  'codestral':         {displayName:'Codestral',           provider:'Mistral',  contextWindow:'256K', tags:['code','fast']},
  'command-a':         {displayName:'Command A',           provider:'Cohere',   contextWindow:'256K', tags:['chat','rag','enterprise']},
};

/* ── Provider logo hints ─────────────────────────────────────────────── */

interface ProviderHint { name: string; logo: string; }
const PROVIDER_HINTS: [RegExp, ProviderHint][] = [
  [/claude/i,            {name:'Anthropic', logo:'/logos/anthropic.png'}],
  [/gpt|^o[34]/i,       {name:'OpenAI',    logo:'/logos/openai.png'}],
  [/gemini|gemma/i,      {name:'Google',    logo:'/logos/google.png'}],
  [/llama/i,             {name:'Meta',      logo:'/logos/meta.png'}],
  [/deepseek/i,          {name:'DeepSeek',  logo:'/logos/deepseek.png'}],
  [/mistral|codestral/i, {name:'Mistral',   logo:'/logos/mistral.png'}],
  [/command/i,           {name:'Cohere',    logo:'/logos/cohere.png'}],
  [/qwen/i,              {name:'Qwen',      logo:'/logos/qwen.png'}],
  [/kimi|moonshot/i,     {name:'Moonshot',  logo:'/logos/moonshot.png'}],
  [/minimax/i,           {name:'MiniMax',   logo:'/logos/minimax.png'}],
];
function guessProvider(id: string) { for (const [re, h] of PROVIDER_HINTS) if (re.test(id)) return h.name; return 'Unknown'; }
function guessLogo(id: string) {
  for (const [re, h] of PROVIDER_HINTS) if (re.test(id)) return h.logo;
  const l = (id[0] ?? '?').toUpperCase();
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#64748b"/><text x="20" y="27" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="20" fill="#fff">${l}</text></svg>`)}`;
}

/* ── Row / group types ───────────────────────────────────────────────── */

interface ServiceRow {
  id: string;
  serviceId: string;
  name: string;
  provider: string;
  logoUrl: string;
  contextWindow: string;
  tags: string[];
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number | null;
  peerCount: number;
  peerName: string;
  region: string;
  stakeUsdc: number;
  settlementCount: number;
  firstSeenAt: number;
  lastSeenAt: number;          // peer.timestamp (last announce)
  onChainLastSeenAt: number;   // onChainStats.lastSeenAt
  totalTokens: number;
  uniqueBuyers: number;
  onChainChannels: number;
  maxConcurrency: number;
  currentLoad: number;
}

interface ModelGroup {
  serviceId: string;
  name: string;
  provider: string;
  logoUrl: string;
  contextWindow: string;
  tags: string[];
  rows: ServiceRow[];
  bestInputPrice: number;
  bestOutputPrice: number;
  totalTokens: number;
}

/* ── Build rows ──────────────────────────────────────────────────────── */

function buildServiceRows(peers: PeerMetadata[]): ServiceRow[] {
  const peerCountMap = new Map<string, number>();
  for (const peer of peers)
    for (const ann of peer.providers)
      for (const svc of ann.services)
        peerCountMap.set(svc, (peerCountMap.get(svc) ?? 0) + 1);

  const rows: ServiceRow[] = [];
  for (const peer of peers) {
    const pName = peer.displayName ?? peer.peerId.slice(0, 12);
    const stats = peer.onChainStats;

    for (const ann of peer.providers) {
      for (const svc of ann.services) {
        const pricing = ann.servicePricing?.[svc] ?? ann.defaultPricing;
        const meta    = MODEL_META[svc];
        const cats    = ann.serviceCategories?.[svc] ?? [];
        const fallback = svc.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        rows.push({
          id:               `${svc}::${pName}`,
          serviceId:        svc,
          name:             meta?.displayName ?? fallback,
          provider:         meta?.provider    ?? guessProvider(svc),
          logoUrl:          guessLogo(svc),
          contextWindow:    meta?.contextWindow ?? '—',
          tags:             ['anon', ...(meta?.tags ?? cats)],
          inputPrice:       pricing.inputUsdPerMillion,
          outputPrice:      pricing.outputUsdPerMillion,
          cachedInputPrice: pricing.cachedInputUsdPerMillion ?? null,
          peerCount:        peerCountMap.get(svc) ?? 1,
          peerName:         pName,
          region:           peer.region ?? '',
          stakeUsdc:        peer.stakeAmountUSDC ?? 0,
          settlementCount:  stats?.settlementCount ?? 0,
          firstSeenAt:      stats?.firstSeenAt     ?? 0,
          lastSeenAt:       peer.timestamp         ?? 0,
          onChainLastSeenAt:stats?.lastSeenAt       ?? 0,
          totalTokens:      (parseInt(stats?.totalInputTokens ?? '0', 10) + parseInt(stats?.totalOutputTokens ?? '0', 10)),
          uniqueBuyers:     stats?.uniqueBuyers     ?? 0,
          onChainChannels:  peer.onChainChannelCount ?? 0,
          maxConcurrency:   ann.maxConcurrency       ?? 0,
          currentLoad:      ann.currentLoad          ?? 0,
        });
      }
    }
  }
  return rows;
}

function groupByModel(rows: ServiceRow[]): ModelGroup[] {
  const map = new Map<string, ServiceRow[]>();
  for (const r of rows) { const e = map.get(r.serviceId) ?? []; e.push(r); map.set(r.serviceId, e); }
  const groups: ModelGroup[] = [];
  for (const [, svcRows] of map) {
    const sorted = [...svcRows].sort((a, b) => a.inputPrice - b.inputPrice || a.outputPrice - b.outputPrice);
    const first = sorted[0]!;
    groups.push({
      serviceId: first.serviceId, name: first.name, provider: first.provider,
      logoUrl: first.logoUrl, contextWindow: first.contextWindow, tags: first.tags,
      rows: sorted,
      bestInputPrice:  first.inputPrice,
      bestOutputPrice: first.outputPrice,
      totalTokens:     svcRows.reduce((s, r) => s + r.totalTokens, 0),
    });
  }
  return groups.sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

const TAG_CLASS: Record<string, string> = {
  anon: styles.tagAnon, coding: styles.tagCoding, code: styles.tagCode, privacy: styles.tagPrivacy,
  tee: styles.tagTee, chat: styles.tagChat, fast: styles.tagFast, cheap: styles.tagCheap,
  reasoning: styles.tagReasoning, 'open-source': styles.tagOpenSource,
  rag: styles.tagRag, enterprise: styles.tagEnterprise,
};

type SortKey  = 'name' | 'inputPrice' | 'outputPrice' | 'peerCount' | 'totalTokens' | 'uniqueBuyers';
type SortDir  = 'asc' | 'desc';
type ViewMode = 'grouped' | 'flat';

function formatPrice(p: number): string {
  if (p === 0 || p < 0.01) return 'Free';
  if (p < 1) return `$${p.toFixed(2)}`;
  return `$${p % 1 === 0 ? p : p.toFixed(2)}`;
}
function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function formatUSDC(n: number): string {
  if (!n) return '';
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function timeAgo(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 120)        return 'just now';
  if (diff < 3600)       return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)      return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7)  return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 86400 / 7)}w ago`;
}
/** green = seen < 10 min, yellow = < 2h, red = older */
function freshnessColor(ts: number): 'green' | 'yellow' | 'red' {
  if (!ts) return 'red';
  const diff = Date.now() / 1000 - ts;
  if (diff < 600)   return 'green';
  if (diff < 7200)  return 'yellow';
  return 'red';
}

interface Filters { maxInputPct: number; maxOutputPct: number; minVolume: number; supportsCaching: boolean; }
const DEFAULT_FILTERS: Filters = { maxInputPct: 100, maxOutputPct: 100, minVolume: 0, supportsCaching: false };

/* ── Quick picks ─────────────────────────────────────────────────────── */

interface QuickPick {
  id: string;
  label: string;
  emoji: string;
  apply: (rows: ServiceRow[], bounds: {maxInput: number; maxTokens: number}) => (r: ServiceRow) => boolean;
  sort?: { key: SortKey; dir: SortDir };
}

const QUICK_PICKS: QuickPick[] = [
  {
    id: 'cheapest',
    label: 'Cheapest',
    emoji: '💰',
    apply: (rows, bounds) => {
      const threshold = Math.min(...rows.map(r => r.inputPrice)) * 2.5;
      return r => r.inputPrice <= threshold;
    },
    sort: { key: 'inputPrice', dir: 'asc' },
  },
  {
    id: 'reasoning',
    label: 'Reasoning',
    emoji: '🧠',
    apply: () => r => r.tags.includes('reasoning'),
  },
  {
    id: 'coding',
    label: 'Coding',
    emoji: '💻',
    apply: () => r => r.tags.includes('code') || r.tags.includes('coding'),
  },
  {
    id: 'fast',
    label: 'Fast',
    emoji: '⚡',
    apply: () => r => r.tags.includes('fast'),
  },
  {
    id: 'high-volume',
    label: 'Proven',
    emoji: '🏆',
    apply: (rows, bounds) => {
      const threshold = bounds.maxTokens * 0.1;
      return r => r.totalTokens >= threshold || r.settlementCount > 10;
    },
    sort: { key: 'totalTokens', dir: 'desc' },
  },
  {
    id: 'new',
    label: 'New',
    emoji: '🆕',
    apply: () => {
      const cutoff = Date.now() / 1000 - 86400 * 14; // last 2 weeks
      return r => r.firstSeenAt > cutoff;
    },
  },
  {
    id: 'open-source',
    label: 'Open Source',
    emoji: '🔓',
    apply: () => r => r.tags.includes('open-source'),
  },
  {
    id: 'cached',
    label: 'Cached pricing',
    emoji: '⚡',
    apply: () => r => r.cachedInputPrice !== null,
    sort: { key: 'inputPrice', dir: 'asc' },
  },
];

/* ── Provider dropdown ───────────────────────────────────────────────── */

function ProviderDropdown({ peers, value, onChange }: { peers: string[]; value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = peers.filter(p => !search || p.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className={styles.providerDropdownWrap} ref={ref}>
      <button className={`${styles.providerDropdownTrigger} ${value ? styles.providerDropdownActive : ''}`} onClick={() => setOpen(v => !v)}>
        <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
          <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd"/>
        </svg>
        {value ?? 'All Providers'}
        <svg viewBox="0 0 20 20" fill="currentColor" width="11" height="11" style={{marginLeft:'auto', opacity:0.4}}>
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd"/>
        </svg>
      </button>
      {open && (
        <div className={styles.providerDropdownMenu}>
          <div className={styles.providerDropdownSearch}>
            <input autoFocus placeholder="Search providers…" value={search} onChange={e => setSearch(e.target.value)} className={styles.providerDropdownInput}/>
          </div>
          <div className={styles.providerDropdownList}>
            <button className={`${styles.providerDropdownItem} ${!value ? styles.providerDropdownItemActive : ''}`} onClick={() => { onChange(null); setOpen(false); setSearch(''); }}>All Providers</button>
            {filtered.map(p => (
              <button key={p} className={`${styles.providerDropdownItem} ${value === p ? styles.providerDropdownItemActive : ''}`} onClick={() => { onChange(p === value ? null : p); setOpen(false); setSearch(''); }}>{p}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Freshness dot ───────────────────────────────────────────────────── */

function FreshnessDot({ ts, label }: { ts: number; label?: string }) {
  const color = freshnessColor(ts);
  const ago   = timeAgo(ts);
  return (
    <span
      className={`${styles.freshDot} ${color === 'green' ? styles.freshGreen : color === 'yellow' ? styles.freshYellow : styles.freshRed}`}
      title={ago ? `Last seen: ${ago}` : 'No activity data'}
      aria-label={ago}
    />
  );
}

/* ── Price bar (shows relative cheapness in range) ───────────────────── */

function PriceBar({ value, min, max }: { value: number; min: number; max: number }) {
  if (max <= min) return null;
  const pct = Math.round(((value - min) / (max - min)) * 100);
  const isBest = pct <= 15;
  return (
    <span className={styles.priceBarWrap} title={`${pct}% of price range`}>
      <span className={`${styles.priceBarFill} ${isBest ? styles.priceBarBest : ''}`} style={{width: `${Math.max(4, pct)}%`}} />
    </span>
  );
}

/* ── Model group section ─────────────────────────────────────────────── */

const INITIAL_SHOWN = 3;

function ModelGroupSection({ group, inputMin, inputMax }: { group: ModelGroup; inputMin: number; inputMax: number }) {
  const [expanded, setExpanded] = useState(false);
  const shown  = expanded ? group.rows : group.rows.slice(0, INITIAL_SHOWN);
  const hidden = group.rows.length - INITIAL_SHOWN;

  return (
    <div className={styles.modelGroupCard}>
      {/* Header */}
      <div className={styles.modelGroupHeader}>
        <div className={styles.modelGroupLeft}>
          {group.logoUrl && <img src={group.logoUrl} alt={group.provider} className={styles.modelLogo} onError={e => { (e.target as HTMLImageElement).style.display='none'; }}/>}
          <div className={styles.modelGroupInfo}>
            <div className={styles.modelGroupName}>{group.name}</div>
            <div className={styles.modelGroupMeta}>
              <span className={styles.modelProvider}>{group.provider}</span>
              {group.contextWindow !== '—' && <span className={styles.ctxBadge}>{group.contextWindow} ctx</span>}
              {group.tags.slice(0, 3).map(t => (
                <span key={t} className={`${styles.tagBadge} ${TAG_CLASS[t] ?? styles.tagDefault}`}>{t}</span>
              ))}
            </div>
          </div>
        </div>
        <div className={styles.modelGroupRight}>
          <div className={styles.modelGroupPricing}>
            <span className={styles.priceFrom}>from</span>
            <span className={group.bestInputPrice <= inputMin * 1.5 ? styles.priceGood : styles.priceNormal}>{formatPrice(group.bestInputPrice)}</span>
            <span className={styles.pricingSlash}>/</span>
            <span className={styles.priceNormal}>{formatPrice(group.bestOutputPrice)}</span>
            <span className={styles.pricingUnit}>/M</span>
          </div>
          <div className={styles.modelGroupStats}>
            <span className={styles.modelGroupProviderCount}>{group.rows.length} provider{group.rows.length !== 1 ? 's' : ''}</span>
            {group.totalTokens > 0 && <span className={styles.modelGroupTokens}>{formatNum(group.totalTokens)} tokens</span>}
          </div>
        </div>
      </div>

      {/* Provider sub-table */}
      <div className={styles.providerRows}>
        <div className={styles.providerRowsHeader}>
          <span>Provider</span>
          <span className={styles.colRight}>Input /M</span>
          <span className={styles.colRight}>Output /M</span>
          <span className={`${styles.colRight} ${styles.colHideMd}`}>Cached</span>
          <span className={`${styles.colRight} ${styles.colHideMd}`}>Channels</span>
          <span className={`${styles.colRight} ${styles.colHideSm}`}>Settlements</span>
          <span className={`${styles.colRight} ${styles.colHideSm}`}>Stake</span>
          <span className={`${styles.colRight} ${styles.colHideSm}`}>Live</span>
        </div>

        {shown.map((row, idx) => {
          const isBest  = idx === 0;
          const color   = freshnessColor(row.lastSeenAt);
          return (
            <div key={row.id} className={`${styles.providerRowItem} ${isBest ? styles.providerRowBest : ''}`}>
              {/* Provider name + freshness */}
              <div className={styles.providerRowName}>
                {isBest && <span className={styles.bestBadge}>Best</span>}
                <FreshnessDot ts={row.lastSeenAt} />
                <span className={styles.providerRowNameText} title={row.region ? `Region: ${row.region}` : undefined}>
                  {row.peerName}
                </span>
              </div>

              {/* Input price + bar */}
              <div className={`${styles.providerRowPrice} ${styles.colRight}`}>
                <div className={styles.priceWithBar}>
                  <span className={isBest ? styles.priceGood : styles.priceNormal}>{formatPrice(row.inputPrice)}</span>
                  <PriceBar value={row.inputPrice} min={inputMin} max={inputMax} />
                </div>
              </div>

              {/* Output price */}
              <div className={`${styles.providerRowPrice} ${styles.colRight}`}>
                <span className={styles.priceNormal}>{formatPrice(row.outputPrice)}</span>
              </div>

              {/* Cached pricing */}
              <div className={`${styles.providerRowStat} ${styles.colRight} ${styles.colHideMd}`}>
                {row.cachedInputPrice !== null
                  ? <span className={styles.cachedBadge} title="Cached input price">⚡ {formatPrice(row.cachedInputPrice)}</span>
                  : <span className={styles.statNA}>—</span>}
              </div>

              {/* On-chain channels */}
              <div className={`${styles.providerRowStat} ${styles.colRight} ${styles.colHideMd}`}>
                {row.onChainChannels > 0 ? formatNum(row.onChainChannels) : <span className={styles.statNA}>—</span>}
              </div>

              {/* Settlements */}
              <div className={`${styles.providerRowStat} ${styles.colRight} ${styles.colHideSm}`}>
                {row.settlementCount > 0 ? formatNum(row.settlementCount) : <span className={styles.statNA}>—</span>}
              </div>

              {/* Stake */}
              <div className={`${styles.providerRowStat} ${styles.colRight} ${styles.colHideSm}`}>
                {row.stakeUsdc > 0
                  ? <span className={styles.stakeBadge}>{formatUSDC(row.stakeUsdc)}</span>
                  : <span className={styles.statNA}>—</span>}
              </div>

              {/* Live dot (large) */}
              <div className={`${styles.providerRowStat} ${styles.colRight} ${styles.colHideSm}`}>
                <span className={`${styles.livePill} ${color === 'green' ? styles.livePillGreen : color === 'yellow' ? styles.livePillYellow : styles.livePillRed}`}>
                  {color === 'green' ? 'Live' : color === 'yellow' ? timeAgo(row.lastSeenAt) : 'Stale'}
                </span>
              </div>
            </div>
          );
        })}

        {group.rows.length > INITIAL_SHOWN && (
          <button className={styles.expandBtn} onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Show less ↑' : `Show ${hidden} more provider${hidden !== 1 ? 's' : ''} ↓`}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────────────── */

export default function PricingPage() {
  const [peers, setPeers]             = useState<PeerMetadata[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(false);
  const [updatedAt, setUpdatedAt]     = useState<string | null>(null);
  const [query, setQuery]             = useState('');
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter]     = useState<string | null>(null);
  const [sortKey, setSortKey]         = useState<SortKey>('inputPrice');
  const [sortDir, setSortDir]         = useState<SortDir>('asc');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters]         = useState<Filters>(DEFAULT_FILTERS);
  const [viewMode, setViewMode]       = useState<ViewMode>('grouped');
  const [activeQuickPick, setActiveQuickPick] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const refresh = async () => {
      for (const url of [STATS_URL, DEV_STATS_URL]) {
        try {
          const res = await fetch(url, {signal: AbortSignal.timeout(5000)});
          if (!res.ok) continue;
          const data = (await res.json()) as StatsResponse;
          setPeers(data.peers); setUpdatedAt(data.updatedAt); setLoading(false); setError(false);
          return;
        } catch { /* try next */ }
      }
      setLoading(false); setError(true);
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  const models = useMemo(() => buildServiceRows(peers), [peers]);

  const allPeerNames = useMemo(() =>
    [...new Set(peers.map(p => p.displayName ?? p.peerId.slice(0, 12)))].sort(), [peers]);
  const allTags = useMemo(() =>
    [...new Set(models.flatMap(m => m.tags))].sort(), [models]);
  const totalTokens = useMemo(() =>
    peers.reduce((s, p) => s + parseInt(p.onChainStats?.totalInputTokens ?? '0', 10) + parseInt(p.onChainStats?.totalOutputTokens ?? '0', 10), 0), [peers]);
  const bounds = useMemo(() => ({
    maxInput:  Math.max(...models.map(m => m.inputPrice), 1),
    maxOutput: Math.max(...models.map(m => m.outputPrice), 1),
    maxTokens: Math.max(...models.map(m => m.totalTokens), 1),
  }), [models]);

  const inputPriceRange = useMemo(() => ({
    min: models.length ? Math.min(...models.map(m => m.inputPrice)) : 0,
    max: models.length ? Math.max(...models.map(m => m.inputPrice)) : 1,
  }), [models]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  };
  const sortIcon = (key: SortKey) => sortKey !== key ? '↕' : sortDir === 'asc' ? '↑' : '↓';

  const handleQuickPick = (id: string) => {
    const next = activeQuickPick === id ? null : id;
    setActiveQuickPick(next);
    const pick = QUICK_PICKS.find(p => p.id === id);
    if (pick?.sort && next) { setSortKey(pick.sort.key); setSortDir(pick.sort.dir); }
    else if (!next) { setSortKey('inputPrice'); setSortDir('asc'); }
  };

  const filtered = useMemo(() => {
    const q    = query.toLowerCase();
    const pick = activeQuickPick ? QUICK_PICKS.find(p => p.id === activeQuickPick) : null;
    const pickFn = pick ? pick.apply(models, bounds) : null;

    let list = models.filter(m => {
      if (q && !m.name.toLowerCase().includes(q) && !m.provider.toLowerCase().includes(q) &&
          !m.serviceId.toLowerCase().includes(q) && !m.tags.some(t => t.includes(q)) &&
          !m.peerName.toLowerCase().includes(q)) return false;
      if (providerFilter && m.peerName !== providerFilter) return false;  // ← bug-fix: was peerNames.includes
      if (tagFilter && !m.tags.includes(tagFilter)) return false;
      if (filters.maxInputPct  < 100 && m.inputPrice  > bounds.maxInput  * filters.maxInputPct  / 100) return false;
      if (filters.maxOutputPct < 100 && m.outputPrice > bounds.maxOutput * filters.maxOutputPct / 100) return false;
      if (filters.minVolume    > 0   && m.totalTokens < bounds.maxTokens * filters.minVolume    / 100) return false;
      if (filters.supportsCaching && m.cachedInputPrice === null) return false;
      if (pickFn && !pickFn(m)) return false;
      return true;
    });

    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':         cmp = a.name.localeCompare(b.name); break;
        case 'inputPrice':   cmp = a.inputPrice  - b.inputPrice; break;
        case 'outputPrice':  cmp = a.outputPrice - b.outputPrice; break;
        case 'peerCount':    cmp = a.peerCount   - b.peerCount; break;
        case 'totalTokens':  cmp = a.totalTokens - b.totalTokens; break;
        case 'uniqueBuyers': cmp = a.uniqueBuyers - b.uniqueBuyers; break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [models, query, providerFilter, tagFilter, sortKey, sortDir, filters, bounds, activeQuickPick]);

  const modelGroups       = useMemo(() => groupByModel(filtered), [filtered]);
  const cheapestInput     = models.length ? Math.min(...models.map(m => m.inputPrice)) : 0;
  const totalPeers        = peers.length;
  const uniqueServiceIds  = useMemo(() => new Set(models.map(m => m.serviceId)).size, [models]);
  const liveCount         = useMemo(() => peers.filter(p => freshnessColor(p.timestamp) === 'green').length, [peers]);
  const hasActiveFilters  = filters.maxInputPct < 100 || filters.maxOutputPct < 100 || filters.minVolume > 0 || filters.supportsCaching;
  const updatedLabel      = updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : null;

  const datasetLd = useMemo(() => ({
    '@context': 'https://schema.org', '@type': 'Dataset',
    name: 'AntSeed Live AI Inference Pricing',
    description: 'Live pricing and provider availability for AI models across the AntSeed peer-to-peer network.',
    url: 'https://antseed.com/network',
    keywords: ['AI inference pricing','LLM API pricing','peer-to-peer AI','decentralized AI','OpenRouter alternative','USDC AI payments'],
    creator: {'@type':'Organization', name:'AntSeed', url:'https://antseed.com'},
    distribution: {'@type':'DataDownload', encodingFormat:'application/json', contentUrl:'https://network.antseed.com/stats'},
  }), []);

  return (
    <Layout title="Live AI Inference Pricing" description="Live pricing across the AntSeed peer-to-peer network.">
      <Head>
        <title>Live AI Inference Pricing Across the AntSeed Network | AntSeed</title>
        <link rel="canonical" href="https://antseed.com/network" />
        <link rel="alternate" type="application/json" title="AntSeed live pricing (JSON)" href="https://network.antseed.com/stats" />
        <script type="application/ld+json">{JSON.stringify(datasetLd)}</script>
      </Head>

      <div className={styles.page}>
        {/* ── Hero ── */}
        <div className={styles.header}>
          <Link to="/" className={styles.back}>← Back</Link>
          <p className={styles.eyebrow}>Live Network Data</p>
          <h1 className={styles.title}>Live pricing across the peer-to-peer network.</h1>
          <p className={styles.subtitle}>
            {loading ? 'Loading live network data...' : error
              ? 'Unable to reach the network. Showing cached data if available.'
              : <>Live pricing from <strong>{totalPeers} peer{totalPeers !== 1 ? 's' : ''}</strong> across <strong>{uniqueServiceIds} models</strong>. On-chain settlement — best rate per million tokens.</>
            }
          </p>
        </div>

        {/* ── Stats bar ── */}
        <div className={styles.statsBar}>
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : uniqueServiceIds}</div>
            <div className={styles.statLabel}>Models</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : totalPeers}</div>
            <div className={styles.statLabel}>Peers</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={`${styles.statNum} ${styles.statGreen}`}>{loading ? '—' : liveCount}</div>
            <div className={styles.statLabel}>Live now</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : formatNum(totalTokens)}</div>
            <div className={styles.statLabel}>Tokens served</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statLive}>
              <span className={styles.liveDot} />
              {loading ? 'Connecting' : error ? 'Offline' : 'Live'}
            </div>
            <div className={styles.statLabel}>{updatedLabel ?? (loading ? 'Connecting...' : 'Stats unavailable')}</div>
          </div>
        </div>

        {/* ── Quick picks bar ── */}
        <div className={styles.quickPicks}>
          {QUICK_PICKS.map(pick => (
            <button
              key={pick.id}
              className={`${styles.quickPickBtn} ${activeQuickPick === pick.id ? styles.quickPickBtnActive : ''}`}
              onClick={() => handleQuickPick(pick.id)}
            >
              <span>{pick.emoji}</span>
              {pick.label}
            </button>
          ))}
        </div>

        {/* ── Sticky search + controls ── */}
        <div className={styles.stickyBar}>
          <div className={styles.searchRow}>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/>
              </svg>
              <input ref={searchRef} className={styles.searchInput} placeholder="Search models, providers…"
                value={query} onChange={e => setQuery(e.target.value)}/>
              {query && <button className={styles.clearBtn} onClick={() => setQuery('')}>×</button>}
            </div>

            {allPeerNames.length > 0 && (
              <ProviderDropdown peers={allPeerNames} value={providerFilter} onChange={setProviderFilter}/>
            )}

            <div className={styles.viewToggle}>
              <button className={`${styles.viewBtn} ${viewMode === 'grouped' ? styles.viewBtnActive : ''}`} onClick={() => setViewMode('grouped')} title="Group by model">
                <svg viewBox="0 0 16 16" fill="none" width="13" height="13"><rect x="1" y="2" width="14" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="1" y="7.5" width="14" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.4"/></svg>
                <span className={styles.viewBtnLabel}>By Model</span>
              </button>
              <button className={`${styles.viewBtn} ${viewMode === 'flat' ? styles.viewBtnActive : ''}`} onClick={() => setViewMode('flat')} title="Flat table">
                <svg viewBox="0 0 16 16" fill="none" width="13" height="13"><line x1="1" y1="4" x2="15" y2="4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><line x1="1" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                <span className={styles.viewBtnLabel}>All</span>
              </button>
            </div>

            <button className={`${styles.filterToggle} ${hasActiveFilters ? styles.filterToggleActive : ''}`} onClick={() => setShowFilters(v => !v)}>
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd"/>
              </svg>
              <span className={styles.filterToggleLabel}>Filters{hasActiveFilters ? ' ●' : ''}</span>
            </button>
          </div>

          {showFilters && (
            <div className={styles.advancedFilters}>
              <div className={styles.filterGroup}>
                <div className={styles.filterHeader}>
                  <span className={styles.filterLabel}>Input Price /M</span>
                  <span className={styles.filterValue}>{filters.maxInputPct >= 100 ? 'Any' : `≤ $${(bounds.maxInput * filters.maxInputPct / 100).toFixed(2)}`}</span>
                </div>
                <input type="range" min="0" max="100" step="1" className={styles.filterRange} value={filters.maxInputPct} onChange={e => setFilters(f => ({...f, maxInputPct: Number(e.target.value)}))}/>
              </div>
              <div className={styles.filterGroup}>
                <div className={styles.filterHeader}>
                  <span className={styles.filterLabel}>Output Price /M</span>
                  <span className={styles.filterValue}>{filters.maxOutputPct >= 100 ? 'Any' : `≤ $${(bounds.maxOutput * filters.maxOutputPct / 100).toFixed(2)}`}</span>
                </div>
                <input type="range" min="0" max="100" step="1" className={styles.filterRange} value={filters.maxOutputPct} onChange={e => setFilters(f => ({...f, maxOutputPct: Number(e.target.value)}))}/>
              </div>
              <div className={styles.filterGroup}>
                <div className={styles.filterHeader}>
                  <span className={styles.filterLabel}>Min Volume</span>
                  <span className={styles.filterValue}>{filters.minVolume <= 0 ? 'Any' : `≥ ${formatNum(Math.round(bounds.maxTokens * filters.minVolume / 100))}`}</span>
                </div>
                <input type="range" min="0" max="100" step="1" className={styles.filterRange} value={filters.minVolume} onChange={e => setFilters(f => ({...f, minVolume: Number(e.target.value)}))}/>
              </div>
              <div className={styles.filterGroupToggle}>
                <label className={styles.checkboxLabel}>
                  <input type="checkbox" className={styles.checkbox} checked={filters.supportsCaching} onChange={e => setFilters(f => ({...f, supportsCaching: e.target.checked}))}/>
                  Cached pricing only
                </label>
              </div>
              {hasActiveFilters && <button className={styles.clearFilters} onClick={() => setFilters(DEFAULT_FILTERS)}>Clear all</button>}
            </div>
          )}

          {/* Tag chips */}
          {allTags.length > 0 && (
            <div className={styles.tagChips}>
              <button className={`${styles.chip} ${!tagFilter ? styles.chipActive : ''}`} onClick={() => setTagFilter(null)}>All</button>
              {allTags.map(t => (
                <button key={t} className={`${styles.chip} ${tagFilter === t ? styles.chipActive : ''}`} onClick={() => setTagFilter(tagFilter === t ? null : t)}>{t}</button>
              ))}
            </div>
          )}
        </div>

        {/* ── Results summary ── */}
        <div className={styles.resultsRow}>
          <span className={styles.resultsCount}>
            {loading ? 'Loading…' : viewMode === 'grouped'
              ? `${modelGroups.length} model${modelGroups.length !== 1 ? 's' : ''}`
              : `${filtered.length} service${filtered.length !== 1 ? 's' : ''}`}
          </span>
          {(activeQuickPick || providerFilter || tagFilter || hasActiveFilters || query) && (
            <button className={styles.clearAllFilters} onClick={() => {
              setActiveQuickPick(null); setProviderFilter(null); setTagFilter(null);
              setQuery(''); setFilters(DEFAULT_FILTERS);
            }}>
              Clear all filters ×
            </button>
          )}
        </div>

        {/* ── Grouped view ── */}
        {viewMode === 'grouped' && (
          loading ? (
            <div className={styles.groupedList}>
              {Array.from({length: 4}).map((_, i) => (
                <div key={i} className={`${styles.modelGroupCard} ${styles.skeletonCard}`}>
                  <div className={styles.modelGroupHeader}><div className={styles.skeletonLine} style={{width:200}}/></div>
                </div>
              ))}
            </div>
          ) : modelGroups.length === 0 ? (
            <div className={styles.emptyState}>
              {error ? 'Could not reach the network.' : 'No models match your filters.'}
              {(activeQuickPick || query) && <button className={styles.clearFiltersInline} onClick={() => { setActiveQuickPick(null); setQuery(''); }}>Clear filters</button>}
            </div>
          ) : (
            <div className={styles.groupedList}>
              {modelGroups.map(group => (
                <ModelGroupSection key={group.serviceId} group={group} inputMin={inputPriceRange.min} inputMax={inputPriceRange.max}/>
              ))}
            </div>
          )
        )}

        {/* ── Flat table ── */}
        {viewMode === 'flat' && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thModel}  onClick={() => toggleSort('name')}>Service {sortIcon('name')}</th>
                  <th className={styles.thPrice}  onClick={() => toggleSort('inputPrice')}>Input /M {sortIcon('inputPrice')}</th>
                  <th className={styles.thPrice}  onClick={() => toggleSort('outputPrice')}>Output /M {sortIcon('outputPrice')}</th>
                  <th className={styles.thStat}   onClick={() => toggleSort('totalTokens')}>Tokens {sortIcon('totalTokens')}</th>
                  <th className={styles.thStat}   onClick={() => toggleSort('uniqueBuyers')}>Users {sortIcon('uniqueBuyers')}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className={styles.emptyRow}>Discovering peers on the network…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={5} className={styles.emptyRow}>{error ? 'Could not reach the network.' : 'No services match your search.'}</td></tr>
                ) : filtered.map(m => (
                  <tr key={m.id} className={styles.row}>
                    <td className={styles.tdModel}>
                      <div className={styles.modelCell}>
                        {m.logoUrl && <img src={m.logoUrl} alt={m.provider} className={styles.modelLogo} onError={e => { (e.target as HTMLImageElement).style.display='none'; }}/>}
                        <div className={styles.modelInfo}>
                          <div className={styles.modelName}>{m.name}</div>
                          <div className={styles.modelMeta}>
                            <FreshnessDot ts={m.lastSeenAt}/>
                            <span className={styles.providerName}>via {m.peerName}</span>
                            {m.tags.map(t => <span key={t} className={`${styles.tagBadge} ${TAG_CLASS[t] ?? styles.tagDefault}`}>{t}</span>)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={styles.tdPrice}>
                      <div className={styles.priceWithBar}>
                        <span className={m.inputPrice < 0.01 ? styles.priceFree : m.inputPrice <= cheapestInput * 1.5 ? styles.priceGood : styles.priceNormal}>{formatPrice(m.inputPrice)}</span>
                        <PriceBar value={m.inputPrice} min={inputPriceRange.min} max={inputPriceRange.max}/>
                      </div>
                    </td>
                    <td className={styles.tdPrice}><span className={m.outputPrice < 0.01 ? styles.priceFree : styles.priceNormal}>{formatPrice(m.outputPrice)}</span></td>
                    <td className={styles.tdStat}><span className={styles.statValue}>{formatNum(m.totalTokens)}</span></td>
                    <td className={styles.tdStat}><span className={styles.statValue}>{formatNum(m.uniqueBuyers)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.footer}>
          <p>Prices and token volumes from live AntSeed network peers. On-chain stats from Base. Updates every 30s.</p>
          <p>Want to become a provider? <Link to="/docs/install">Read the docs →</Link></p>
        </div>
      </div>
    </Layout>
  );
}
