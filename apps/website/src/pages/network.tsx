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
}

interface StatsResponse {
  peers: PeerMetadata[];
  updatedAt: string;
}

/* ── Static model enrichment (logos, context, tags) ───────────────── */
// The stats API provides pricing & availability; this map adds metadata
// that the protocol doesn't carry (logos, context windows, tags).

interface ModelMeta {
  displayName: string;
  provider: string;
  contextWindow: string;
  tags: string[];
}

const MODEL_META: Record<string, ModelMeta> = {
  // Anthropic
  'claude-opus-4-6':      {displayName:'Claude Opus 4.6',    provider:'Anthropic', contextWindow:'200K', tags:['chat','code','reasoning']},
  'claude-sonnet-4-6':    {displayName:'Claude Sonnet 4.6',  provider:'Anthropic', contextWindow:'200K', tags:['chat','code','fast']},
  'claude-haiku-4-5':     {displayName:'Claude Haiku 4.5',   provider:'Anthropic', contextWindow:'200K', tags:['chat','fast','cheap']},
  // OpenAI
  'gpt-4.1':              {displayName:'GPT-4.1',            provider:'OpenAI',    contextWindow:'1M',   tags:['chat','code','reasoning']},
  'gpt-4.1-mini':         {displayName:'GPT-4.1 Mini',       provider:'OpenAI',    contextWindow:'1M',   tags:['chat','fast','cheap']},
  'gpt-4.1-nano':         {displayName:'GPT-4.1 Nano',       provider:'OpenAI',    contextWindow:'1M',   tags:['chat','fast','cheap']},
  'o3':                   {displayName:'o3',                  provider:'OpenAI',    contextWindow:'200K', tags:['reasoning','code']},
  'o4-mini':              {displayName:'o4-mini',             provider:'OpenAI',    contextWindow:'200K', tags:['reasoning','fast']},
  // Google
  'gemini-2.5-pro':       {displayName:'Gemini 2.5 Pro',     provider:'Google',    contextWindow:'1M',   tags:['chat','code','reasoning']},
  'gemini-2.5-flash':     {displayName:'Gemini 2.5 Flash',   provider:'Google',    contextWindow:'1M',   tags:['chat','fast','cheap']},
  // Meta
  'llama-4-maverick':     {displayName:'Llama 4 Maverick',   provider:'Meta',      contextWindow:'1M',   tags:['chat','code','open-source']},
  'llama-4-scout':        {displayName:'Llama 4 Scout',      provider:'Meta',      contextWindow:'512K', tags:['chat','fast','open-source']},
  // DeepSeek
  'deepseek-r1':          {displayName:'DeepSeek R1',         provider:'DeepSeek',  contextWindow:'128K', tags:['reasoning','code','open-source']},
  'deepseek-v3':          {displayName:'DeepSeek V3',         provider:'DeepSeek',  contextWindow:'128K', tags:['chat','code','open-source']},
  // Mistral
  'mistral-large':        {displayName:'Mistral Large',       provider:'Mistral',   contextWindow:'128K', tags:['chat','code','reasoning']},
  'codestral':            {displayName:'Codestral',            provider:'Mistral',   contextWindow:'256K', tags:['code','fast']},
  // Cohere
  'command-a':            {displayName:'Command A',            provider:'Cohere',    contextWindow:'256K', tags:['chat','rag','enterprise']},
};

/* ── Aggregated model row (derived from live peers) ───────────────── */

interface ModelRow {
  id: string;
  name: string;
  provider: string;
  logoUrl: string;
  contextWindow: string;
  tags: string[];
  inputPrice: number;      // best (cheapest) across all peers
  outputPrice: number;     // best (cheapest) across all peers
  peerCount: number;       // how many peers serve this model
  peerNames: string[];     // all peer names serving this model
  categories: string[];    // on-chain categories from providers
  bestPeerName?: string;   // cheapest provider peer name
  avgReputation?: number;  // average on-chain reputation of serving peers
}

function aggregateModels(peers: PeerMetadata[]): ModelRow[] {
  // Map: serviceId → aggregated data
  const map = new Map<string, {
    bestInput: number;
    bestOutput: number;
    peerCount: number;
    peerNames: Set<string>;
    bestPeerName?: string;
    categories: Set<string>;
    reputations: number[];
  }>();

  for (const peer of peers) {
    const pName = peer.displayName ?? peer.peerId.slice(0, 12);
    for (const ann of peer.providers) {
      for (const service of ann.services) {
        const pricing = ann.servicePricing?.[service] ?? ann.defaultPricing;

        const existing = map.get(service);
        if (!existing) {
          map.set(service, {
            bestInput: pricing.inputUsdPerMillion,
            bestOutput: pricing.outputUsdPerMillion,
            peerCount: 1,
            peerNames: new Set([pName]),
            bestPeerName: pName,
            categories: new Set(ann.serviceCategories?.[service] ?? []),
            reputations: peer.onChainReputation != null ? [peer.onChainReputation] : [],
          });
        } else {
          existing.peerCount++;
          existing.peerNames.add(pName);
          if (peer.onChainReputation != null) existing.reputations.push(peer.onChainReputation);
          for (const cat of ann.serviceCategories?.[service] ?? []) existing.categories.add(cat);

          // Track cheapest input price
          if (pricing.inputUsdPerMillion < existing.bestInput) {
            existing.bestInput = pricing.inputUsdPerMillion;
            existing.bestPeerName = peer.displayName;
          }
          // Track cheapest output price independently
          if (pricing.outputUsdPerMillion < existing.bestOutput) {
            existing.bestOutput = pricing.outputUsdPerMillion;
          }
        }
      }
    }
  }

  const rows: ModelRow[] = [];
  for (const [serviceId, data] of map) {
    const meta = MODEL_META[serviceId];
    // Clean up the service ID into a display name
    const fallbackName = serviceId
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    rows.push({
      id: serviceId,
      name: meta?.displayName ?? fallbackName,
      provider: meta?.provider ?? guessProvider(serviceId),
      logoUrl: guessLogo(serviceId),
      contextWindow: meta?.contextWindow ?? '—',
      tags: meta?.tags ?? [...data.categories],
      inputPrice: data.bestInput,
      outputPrice: data.bestOutput,
      peerCount: data.peerCount,
      peerNames: [...data.peerNames],
      categories: [...data.categories],
      bestPeerName: data.bestPeerName,
      avgReputation: data.reputations.length > 0
        ? data.reputations.reduce((a, b) => a + b, 0) / data.reputations.length
        : undefined,
    });
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
  return '';
}

/* ── Helpers ──────────────────────────────────────────────────────── */

const TAG_CLASS: Record<string, string> = {
  coding: styles.tagCoding, code: styles.tagCode, privacy: styles.tagPrivacy,
  tee: styles.tagTee, chat: styles.tagChat, fast: styles.tagFast,
  cheap: styles.tagCheap, reasoning: styles.tagReasoning,
  'open-source': styles.tagOpenSource, rag: styles.tagRag,
  enterprise: styles.tagEnterprise,
};

type SortKey = 'name' | 'inputPrice' | 'outputPrice' | 'peerCount';
type SortDir = 'asc' | 'desc';

function formatPrice(p: number): string {
  if (p === 0) return 'Free';
  if (p < 0.01) return 'Free';
  if (p < 1) return `$${p.toFixed(2)}`;
  return `$${p % 1 === 0 ? p : p.toFixed(2)}`;
}

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

  // Fetch live network data
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

  // Aggregate models from live peers
  const models = useMemo(() => aggregateModels(peers), [peers]);

  const allPeerNames = useMemo(() => [...new Set(peers.map(p => p.displayName ?? p.peerId.slice(0, 12)))].sort(), [peers]);
  const allTags = useMemo(() => [...new Set(models.flatMap(m => m.tags))].sort(), [models]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
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
      return true;
    });

    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'inputPrice': cmp = a.inputPrice - b.inputPrice; break;
        case 'outputPrice': cmp = a.outputPrice - b.outputPrice; break;
        case 'peerCount': cmp = a.peerCount - b.peerCount; break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [models, query, providerFilter, tagFilter, sortKey, sortDir]);

  const cheapestInput = models.length > 0 ? Math.min(...models.map(m => m.inputPrice)) : 0;
  const totalPeers = peers.length;

  const updatedLabel = updatedAt
    ? `Updated ${new Date(updatedAt).toLocaleTimeString()}`
    : null;

  return (
    <Layout title="Pricing" description="Compare AI model pricing across AntSeed network providers. Find the best rates for input and output tokens.">
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
                : <>Live pricing from {totalPeers} peer{totalPeers !== 1 ? 's' : ''} across {models.length} models. Best rate per million tokens.</>
            }
          </p>
        </div>

        {/* Stats */}
        <div className={styles.statsBar}>
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : models.length}</div>
            <div className={styles.statLabel}>Models</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '—' : totalPeers}</div>
            <div className={styles.statLabel}>Active Peers</div>
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
          <div className={styles.searchWrap}>
            <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/>
            </svg>
            <input
              className={styles.searchInput}
              placeholder="Search models, providers, or capabilities..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {query && (
              <button className={styles.clearBtn} onClick={() => setQuery('')} aria-label="Clear search">×</button>
            )}
          </div>

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
          {loading ? 'Loading...' : `${filtered.length} model${filtered.length !== 1 ? 's' : ''} found`}
        </div>

        {/* Table */}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thModel} onClick={() => toggleSort('name')}>
                  Model {sortIcon('name')}
                </th>
                <th className={styles.thPrice} onClick={() => toggleSort('inputPrice')}>
                  Input /M {sortIcon('inputPrice')}
                </th>
                <th className={styles.thPrice} onClick={() => toggleSort('outputPrice')}>
                  Output /M {sortIcon('outputPrice')}
                </th>
                <th className={styles.thProviders} onClick={() => toggleSort('peerCount')}>
                  Peers {sortIcon('peerCount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className={styles.emptyRow}>
                    Discovering peers on the network...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className={styles.emptyRow}>
                    {error ? 'Could not reach the network stats server.' : 'No models match your search. Try a different query or clear filters.'}
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
                          {m.bestPeerName && (
                            <span className={styles.providerName}>via {m.bestPeerName}</span>
                          )}
                          {m.tags.map(t => (
                            <span key={t} className={`${styles.tagBadge} ${TAG_CLASS[t] ?? styles.tagDefault}`}>{t}</span>
                          ))}
                        </div>
                        {m.avgReputation != null && (
                          <div className={styles.reputation}>
                            Rep: {m.avgReputation.toFixed(1)}
                          </div>
                        )}
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
                  <td className={styles.tdProviders}>
                    <span className={styles.peerCount}>{m.peerCount}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* CTA */}
        <div className={styles.footer}>
          <p>Prices are the best available rate from live AntSeed network peers. Updates every 30s.</p>
          <p>Want to become a provider? <Link to="/docs/install">Read the docs →</Link></p>
        </div>
      </div>
    </Layout>
  );
}
