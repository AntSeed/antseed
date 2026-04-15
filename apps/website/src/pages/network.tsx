import {useEffect, useState, useMemo} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './network.module.css';

/* ── Stats API types (mirrors PeerMetadata from @antseed/node) ──── */

const STATS_URL = 'https://network.antseed.com/stats';
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

interface StatsResponse {
  peers: PeerMetadata[];
  updatedAt: string;
}

/* ── Static model enrichment (logos, context, tags) ───────────────── */

interface ModelMeta {
  displayName: string;
  provider: string;
  contextWindow: string;
  tags: string[];
}

const MODEL_META: Record<string, ModelMeta> = {
  'claude-opus-4-6':      {displayName:'Claude Opus 4.6',    provider:'Anthropic', contextWindow:'200K', tags:['chat','code','reasoning']},
  'claude-sonnet-4-6':    {displayName:'Claude Sonnet 4.6',  provider:'Anthropic', contextWindow:'200K', tags:['chat','code','fast']},
  'claude-haiku-4-5':     {displayName:'Claude Haiku 4.5',   provider:'Anthropic', contextWindow:'200K', tags:['chat','fast','cheap']},
  'gpt-4.1':              {displayName:'GPT-4.1',            provider:'OpenAI',    contextWindow:'1M',   tags:['chat','code','reasoning']},
  'gpt-4.1-mini':         {displayName:'GPT-4.1 Mini',       provider:'OpenAI',    contextWindow:'1M',   tags:['chat','fast','cheap']},
  'gpt-4.1-nano':         {displayName:'GPT-4.1 Nano',       provider:'OpenAI',    contextWindow:'1M',   tags:['chat','fast','cheap']},
  'o3':                   {displayName:'o3',                  provider:'OpenAI',    contextWindow:'200K', tags:['reasoning','code']},
  'o4-mini':              {displayName:'o4-mini',             provider:'OpenAI',    contextWindow:'200K', tags:['reasoning','fast']},
  'gemini-2.5-pro':       {displayName:'Gemini 2.5 Pro',     provider:'Google',    contextWindow:'1M',   tags:['chat','code','reasoning']},
  'gemini-2.5-flash':     {displayName:'Gemini 2.5 Flash',   provider:'Google',    contextWindow:'1M',   tags:['chat','fast','cheap']},
  'llama-4-maverick':     {displayName:'Llama 4 Maverick',   provider:'Meta',      contextWindow:'1M',   tags:['chat','code','open-source']},
  'llama-4-scout':        {displayName:'Llama 4 Scout',      provider:'Meta',      contextWindow:'512K', tags:['chat','fast','open-source']},
  'deepseek-r1':          {displayName:'DeepSeek R1',         provider:'DeepSeek',  contextWindow:'128K', tags:['reasoning','code','open-source']},
  'deepseek-v3':          {displayName:'DeepSeek V3',         provider:'DeepSeek',  contextWindow:'128K', tags:['chat','code','open-source']},
  'mistral-large':        {displayName:'Mistral Large',       provider:'Mistral',   contextWindow:'128K', tags:['chat','code','reasoning']},
  'codestral':            {displayName:'Codestral',            provider:'Mistral',   contextWindow:'256K', tags:['code','fast']},
  'command-a':            {displayName:'Command A',            provider:'Cohere',    contextWindow:'256K', tags:['chat','rag','enterprise']},
};

/* ── One row per service per peer ──────────────────────────────────── */

interface ServiceRow {
  id: string;           // serviceId::peerName (unique key)
  serviceId: string;
  name: string;
  provider: string;
  logoUrl: string;
  contextWindow: string;
  tags: string[];
  inputPrice: number;
  outputPrice: number;
  peerCount: number;    // how many peers serve this same service
  peerNames: string[];
  peerName: string;     // the specific peer for this row
  categories: string[];
  // On-chain stats for this peer
  totalTokens: number;
  uniqueBuyers: number;
}

function buildServiceRows(peers: PeerMetadata[]): ServiceRow[] {
  // First pass: count how many peers serve each service
  const peerCountMap = new Map<string, Set<string>>();
  for (const peer of peers) {
    const pName = peer.displayName ?? peer.peerId.slice(0, 12);
    for (const ann of peer.providers) {
      for (const service of ann.services) {
        if (!peerCountMap.has(service)) peerCountMap.set(service, new Set());
        peerCountMap.get(service)!.add(pName);
      }
    }
  }

  // Second pass: one row per service per peer
  const rows: ServiceRow[] = [];
  for (const peer of peers) {
    const pName = peer.displayName ?? peer.peerId.slice(0, 12);
    const stats = peer.onChainStats;

    for (const ann of peer.providers) {
      for (const service of ann.services) {
        const pricing = ann.servicePricing?.[service] ?? ann.defaultPricing;
        const meta = MODEL_META[service];
        const cats = ann.serviceCategories?.[service] ?? [];
        const fallbackName = service
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());
        const peersForService = peerCountMap.get(service)!;

        rows.push({
          id: `${service}::${pName}`,
          serviceId: service,
          name: meta?.displayName ?? fallbackName,
          provider: meta?.provider ?? guessProvider(service),
          logoUrl: guessLogo(service),
          contextWindow: meta?.contextWindow ?? '—',
          tags: ['anon', ...(meta?.tags ?? cats)],
          inputPrice: pricing.inputUsdPerMillion,
          outputPrice: pricing.outputUsdPerMillion,
          peerCount: peersForService.size,
          peerNames: [...peersForService],
          peerName: pName,
          categories: cats,
          totalTokens: (parseInt(stats?.totalInputTokens ?? '0', 10) + parseInt(stats?.totalOutputTokens ?? '0', 10)),
          uniqueBuyers: stats?.uniqueBuyers ?? 0,
        });
      }
    }
  }

  return rows;
}

interface ProviderHint { name: string; logo: string; }

const PROVIDER_HINTS: [RegExp, ProviderHint][] = [
  [/claude/i,                {name:'Anthropic', logo:'/logos/anthropic.png'}],
  [/gpt|^o[34]/i,           {name:'OpenAI',    logo:'/logos/openai.png'}],
  [/gemini|gemma/i,          {name:'Google',    logo:'/logos/google.png'}],
  [/llama/i,                 {name:'Meta',      logo:'/logos/meta.png'}],
  [/deepseek/i,              {name:'DeepSeek',  logo:'/logos/deepseek.png'}],
  [/mistral|codestral/i,     {name:'Mistral',   logo:'/logos/mistral.png'}],
  [/command/i,               {name:'Cohere',    logo:'/logos/cohere.png'}],
  [/qwen/i,                  {name:'Qwen',      logo:'/logos/qwen.png'}],
  [/glm/i,                   {name:'Zhipu AI',  logo:'/logos/zhipu.png'}],
  [/kimi|moonshot/i,         {name:'Moonshot',  logo:'/logos/moonshot.png'}],
  [/minimax/i,               {name:'MiniMax',   logo:'/logos/minimax.png'}],
];

function guessProvider(serviceId: string): string {
  for (const [re, hint] of PROVIDER_HINTS) if (re.test(serviceId)) return hint.name;
  return 'Unknown';
}

function guessLogo(serviceId: string): string {
  for (const [re, hint] of PROVIDER_HINTS) if (re.test(serviceId)) return hint.logo;
  const letter = (serviceId[0] ?? '?').toUpperCase();
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#64748b"/><text x="20" y="27" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="20" fill="#fff">${letter}</text></svg>`)}`;
}

/* ── Helpers ──────────────────────────────────────────────────────── */

const TAG_CLASS: Record<string, string> = {
  anon: styles.tagAnon, coding: styles.tagCoding, code: styles.tagCode, privacy: styles.tagPrivacy,
  tee: styles.tagTee, chat: styles.tagChat, fast: styles.tagFast,
  cheap: styles.tagCheap, reasoning: styles.tagReasoning,
  'open-source': styles.tagOpenSource, rag: styles.tagRag,
  enterprise: styles.tagEnterprise,
};

type SortKey = 'name' | 'inputPrice' | 'outputPrice' | 'peerCount' | 'totalTokens' | 'uniqueBuyers';
type SortDir = 'asc' | 'desc';

function formatPrice(p: number): string {
  if (p === 0 || p < 0.01) return 'Free';
  if (p < 1) return `$${p.toFixed(2)}`;
  return `$${p % 1 === 0 ? p : p.toFixed(2)}`;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* ── Filters state ────────────────────────────────────────────────── */

interface Filters {
  maxInputPct: number;       // 100=Any (right), drag left to limit price
  maxOutputPct: number;      // 100=Any (right), drag left to limit price
  minVolume: number;         // 0=Any (left), drag right to require more volume
  supportsCaching: boolean;
}

const DEFAULT_FILTERS: Filters = {
  maxInputPct: 100,
  maxOutputPct: 100,
  minVolume: 0,
  supportsCaching: false,
};

/* ── Component ────────────────────────────────────────────────────── */

export default function PricingPage() {
  const [peers, setPeers] = useState<PeerMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('inputPrice');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  useEffect(() => {
    const refresh = async () => {
      for (const url of [STATS_URL, DEV_STATS_URL]) {
        try {
          const res = await fetch(url, {signal: AbortSignal.timeout(5000)});
          if (!res.ok) continue;
          const data = (await res.json()) as StatsResponse;
          setPeers(data.peers);
          setUpdatedAt(data.updatedAt);
          setLoading(false);
          setError(false);
          return;
        } catch { /* try next */ }
      }
      setLoading(false);
      setError(true);
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, []);

  const models = useMemo(() => buildServiceRows(peers), [peers]);

  const allPeerNames = useMemo(() => [...new Set(peers.map(p => p.displayName ?? p.peerId.slice(0, 12)))].sort(), [peers]);
  const allTags = useMemo(() => [...new Set(models.flatMap(m => m.tags))].sort(), [models]);
  const uniqueServiceCount = useMemo(() => new Set(models.map(m => m.serviceId)).size, [models]);

  // Totals and bounds for stats bar + sliders
  const totalTokens = useMemo(() => peers.reduce((s, p) => s + parseInt(p.onChainStats?.totalInputTokens ?? '0', 10) + parseInt(p.onChainStats?.totalOutputTokens ?? '0', 10), 0), [peers]);

  const bounds = useMemo(() => ({
    maxInput: Math.max(...models.map(m => m.inputPrice), 1),
    maxOutput: Math.max(...models.map(m => m.outputPrice), 1),
    maxTokens: Math.max(...models.map(m => m.totalTokens), 1),
    maxBuyers: Math.max(...models.map(m => m.uniqueBuyers), 1),
  }), [models]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    let list = models.filter(m => {
      if (q && !m.name.toLowerCase().includes(q) && !m.provider.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q) && !m.tags.some(t => t.includes(q))) return false;
      if (providerFilter && !m.peerNames.includes(providerFilter)) return false;
      if (tagFilter && !m.tags.includes(tagFilter)) return false;
      // Price sliders: 100=Any, lower=stricter
      if (filters.maxInputPct < 100 && m.inputPrice > bounds.maxInput * filters.maxInputPct / 100) return false;
      if (filters.maxOutputPct < 100 && m.outputPrice > bounds.maxOutput * filters.maxOutputPct / 100) return false;
      // Volume slider: 0=Any, higher=require more tokens served
      if (filters.minVolume > 0 && m.totalTokens < bounds.maxTokens * filters.minVolume / 100) return false;
      return true;
    });

    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'inputPrice': cmp = a.inputPrice - b.inputPrice; break;
        case 'outputPrice': cmp = a.outputPrice - b.outputPrice; break;
        case 'peerCount': cmp = a.peerCount - b.peerCount; break;
        case 'totalTokens': cmp = a.totalTokens - b.totalTokens; break;
        case 'uniqueBuyers': cmp = a.uniqueBuyers - b.uniqueBuyers; break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [models, query, providerFilter, tagFilter, sortKey, sortDir, filters]);

  const cheapestInput = models.length > 0 ? Math.min(...models.map(m => m.inputPrice)) : 0;
  const totalPeers = peers.length;

  const updatedLabel = updatedAt
    ? `Updated ${new Date(updatedAt).toLocaleTimeString()}`
    : null;

  const hasActiveFilters = filters.maxInputPct < 100 || filters.maxOutputPct < 100 || filters.minVolume > 0 || filters.supportsCaching;

  return (
    <Layout title="Pricing" description="Compare AI service pricing across AntSeed network providers. Find the best rates for input and output tokens.">
      <div className={styles.page}>
        {/* Hero */}
        <div className={styles.header}>
          <Link to="/" className={styles.back}>← Back</Link>
          <h1 className={styles.title}>Service Pricing</h1>
          <p className={styles.subtitle}>
            {loading
              ? 'Loading live network data...'
              : error
                ? 'Unable to reach the network. Showing cached data if available.'
                : <>Live pricing from {totalPeers} peer{totalPeers !== 1 ? 's' : ''} across {uniqueServiceCount} services. Best rate per million tokens.</>
            }
          </p>
        </div>

        {/* Stats */}
        <div className={styles.statsBar}>
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : uniqueServiceCount}</div>
            <div className={styles.statLabel}>Services</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : totalPeers}</div>
            <div className={styles.statLabel}>Active Peers</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : formatNum(totalTokens)}</div>
            <div className={styles.statLabel}>Tokens Served</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statLive}>
              <span className={styles.liveDot} />
              {loading ? 'Connecting' : error ? 'Offline' : 'Live'}
            </div>
            <div className={styles.statLabel}>
              {updatedLabel ?? (loading ? 'Connecting...' : 'Stats unavailable')}
            </div>
          </div>
        </div>

        {/* Search + Filters */}
        <div className={styles.filterBar}>
          <div className={styles.searchRow}>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/>
              </svg>
              <input
                className={styles.searchInput}
                placeholder="Search services, providers, or capabilities..."
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              {query && (
                <button className={styles.clearBtn} onClick={() => setQuery('')} aria-label="Clear search">×</button>
              )}
            </div>
            <button
              className={`${styles.filterToggle} ${hasActiveFilters ? styles.filterToggleActive : ''}`}
              onClick={() => setShowFilters(v => !v)}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd"/>
              </svg>
              Filters{hasActiveFilters ? ' ●' : ''}
            </button>
          </div>

          {/* Advanced filters panel — hidden on mobile */}
          {showFilters && (
            <div className={styles.advancedFilters}>
              <div className={styles.filterGroup}>
                <div className={styles.filterHeader}>
                  <span className={styles.filterLabel}>Input Price /M</span>
                  <span className={styles.filterValue}>
                    {filters.maxInputPct >= 100 ? 'Any' : `≤ $${(bounds.maxInput * filters.maxInputPct / 100).toFixed(2)}`}
                  </span>
                </div>
                <input type="range" min="0" max="100" step="1"
                  className={styles.filterRange}
                  value={filters.maxInputPct}
                  onChange={e => setFilters(f => ({...f, maxInputPct: Number(e.target.value)}))}
                />
              </div>
              <div className={styles.filterGroup}>
                <div className={styles.filterHeader}>
                  <span className={styles.filterLabel}>Output Price /M</span>
                  <span className={styles.filterValue}>
                    {filters.maxOutputPct >= 100 ? 'Any' : `≤ $${(bounds.maxOutput * filters.maxOutputPct / 100).toFixed(2)}`}
                  </span>
                </div>
                <input type="range" min="0" max="100" step="1"
                  className={styles.filterRange}
                  value={filters.maxOutputPct}
                  onChange={e => setFilters(f => ({...f, maxOutputPct: Number(e.target.value)}))}
                />
              </div>
              <div className={styles.filterGroup}>
                <div className={styles.filterHeader}>
                  <span className={styles.filterLabel}>Tokens Served</span>
                  <span className={styles.filterValue}>
                    {filters.minVolume <= 0 ? 'Any' : `≥ ${formatNum(Math.round(bounds.maxTokens * filters.minVolume / 100))}`}
                  </span>
                </div>
                <input type="range" min="0" max="100" step="1"
                  className={styles.filterRange}
                  value={filters.minVolume}
                  onChange={e => setFilters(f => ({...f, minVolume: Number(e.target.value)}))}
                />
              </div>
              <div className={styles.filterGroupToggle}>
                <label className={styles.checkboxLabel}>
                  <input type="checkbox"
                    className={styles.checkbox}
                    checked={filters.supportsCaching}
                    onChange={e => setFilters(f => ({...f, supportsCaching: e.target.checked}))}
                  />
                  Supports prompt caching
                </label>
              </div>
              {hasActiveFilters && (
                <button className={styles.clearFilters} onClick={() => setFilters(DEFAULT_FILTERS)}>Clear all</button>
              )}
            </div>
          )}

          {allPeerNames.length > 0 && (
            <div className={styles.filterChips}>
              <button
                className={`${styles.chip} ${!providerFilter ? styles.chipActive : ''}`}
                onClick={() => setProviderFilter(null)}
              >All Providers</button>
              {allPeerNames.map(p => (
                <button
                  key={p}
                  className={`${styles.chip} ${providerFilter === p ? styles.chipActive : ''}`}
                  onClick={() => setProviderFilter(providerFilter === p ? null : p)}
                >{p}</button>
              ))}
            </div>
          )}

          {allTags.length > 0 && (
            <div className={styles.filterChips}>
              <button
                className={`${styles.chip} ${!tagFilter ? styles.chipActive : ''}`}
                onClick={() => setTagFilter(null)}
              >All Tags</button>
              {allTags.map(t => (
                <button
                  key={t}
                  className={`${styles.chip} ${tagFilter === t ? styles.chipActive : ''}`}
                  onClick={() => setTagFilter(tagFilter === t ? null : t)}
                >{t}</button>
              ))}
            </div>
          )}
        </div>

        {/* Results count */}
        <div className={styles.resultsCount}>
          {loading ? 'Loading...' : `${filtered.length} service${filtered.length !== 1 ? 's' : ''} found`}
        </div>

        {/* Table */}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thModel} onClick={() => toggleSort('name')}>
                  Service {sortIcon('name')}
                </th>
                <th className={styles.thPrice} onClick={() => toggleSort('inputPrice')}>
                  Input /M {sortIcon('inputPrice')}
                </th>
                <th className={styles.thPrice} onClick={() => toggleSort('outputPrice')}>
                  Output /M {sortIcon('outputPrice')}
                </th>
                <th className={styles.thStat} onClick={() => toggleSort('totalTokens')}>
                  Tokens {sortIcon('totalTokens')}
                </th>
                <th className={styles.thStat} onClick={() => toggleSort('uniqueBuyers')}>
                  Users {sortIcon('uniqueBuyers')}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>
                    Discovering peers on the network...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>
                    {error ? 'Could not reach the network stats server.' : 'No services match your search. Try a different query or clear filters.'}
                  </td>
                </tr>
              ) : filtered.map(m => (
                <tr key={m.id} className={styles.row}>
                  <td className={styles.tdModel}>
                    <div className={styles.modelCell}>
                      {m.logoUrl && (
                        <img
                          src={m.logoUrl}
                          alt={m.provider}
                          className={styles.modelLogo}
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                      <div className={styles.modelInfo}>
                        <div className={styles.modelName}>{m.name}</div>
                        <div className={styles.modelMeta}>
                          <span className={styles.providerName}>via {m.peerName}</span>
                          {m.tags.map(t => (
                            <span key={t} className={`${styles.tagBadge} ${TAG_CLASS[t] ?? styles.tagDefault}`}>{t}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className={styles.tdPrice}>
                    <span className={m.inputPrice < 0.01 ? styles.priceFree : models.length > 0 && m.inputPrice <= cheapestInput * 1.5 ? styles.priceGood : styles.priceNormal}>
                      {formatPrice(m.inputPrice)}
                    </span>
                  </td>
                  <td className={styles.tdPrice}>
                    <span className={m.outputPrice < 0.01 ? styles.priceFree : styles.priceNormal}>
                      {formatPrice(m.outputPrice)}
                    </span>
                  </td>
                  <td className={styles.tdStat}>
                    <span className={styles.statValue}>{formatNum(m.totalTokens)}</span>
                  </td>
                  <td className={styles.tdStat}>
                    <span className={styles.statValue}>{formatNum(m.uniqueBuyers)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* CTA */}
        <div className={styles.footer}>
          <p>Prices and token volumes from live AntSeed network peers. On-chain stats from Base. Updates every 30s.</p>
          <p>Want to become a provider? <Link to="/docs/install">Read the docs →</Link></p>
        </div>
      </div>
    </Layout>
  );
}
