import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchStats } from './api';
import { PeerPage } from './PeerPage';
import {
  formatLargeNumber,
  formatRelative,
  formatSeconds,
  formatUsd,
  MoonIcon,
  parseUpdatedAt,
  SectionHead,
  shortPeerId,
  StatCard,
  SunIcon,
  useTheme,
  useTick,
} from './utils';

const HISTOGRAM_DEFAULT_LIMIT = 12;

function Histogram({
  title,
  caption,
  data,
  formatLabel,
  limit = HISTOGRAM_DEFAULT_LIMIT,
}: {
  title: string;
  caption: string;
  data: Record<string, number>;
  formatLabel?: (key: string) => string;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  const max = entries[0]?.[1] ?? 0;
  const truncated = !expanded && entries.length > limit;
  const visible = truncated ? entries.slice(0, limit) : entries;
  const hiddenCount = entries.length - limit;

  return (
    <div className="histogram">
      <div className="histogram-head">
        <span className="histogram-title">{title}</span>
        {entries.length > 0 && (
          <span className="histogram-total">{entries.length} buckets</span>
        )}
      </div>
      <div className="histogram-cap">{caption}</div>
      {entries.length === 0 ? (
        <div className="histogram-empty">no data yet</div>
      ) : (
        <>
          <div className="histogram-rows">
            {visible.map(([key, count], i) => (
              <div key={key} className={`histogram-row rank-${Math.min(i, 3)}`}>
                <span className="histogram-label" title={formatLabel?.(key) ?? key}>
                  {formatLabel?.(key) ?? key}
                </span>
                <div className="histogram-bar-wrap">
                  <div
                    className="histogram-bar"
                    style={{ width: `${(count / max) * 100}%` }}
                  />
                </div>
                <span className="histogram-count">{count}</span>
              </div>
            ))}
          </div>
          {entries.length > limit && (
            <button
              type="button"
              className="histogram-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {truncated ? `Show ${hiddenCount} more` : 'Show less'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */

const REFETCH_INTERVAL_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 15 * 60 * 1000;

type Route = 'network' | 'peers';
const ROUTE_STORAGE_KEY = 'antseed-network-stats:route';

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => {
    if (typeof window === 'undefined') return 'network';
    const stored = window.localStorage.getItem(ROUTE_STORAGE_KEY);
    return stored === 'peers' ? 'peers' : 'network';
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(ROUTE_STORAGE_KEY, route);
    } catch {
      // ignore
    }
  }, [route]);

  return [route, setRoute];
}

const PEER_HASH_PREFIX = '#/peer/';

function readHashPeerId(): string | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash;
  if (!h.startsWith(PEER_HASH_PREFIX)) return null;
  const id = decodeURIComponent(h.slice(PEER_HASH_PREFIX.length));
  return id.length > 0 ? id : null;
}

function useHashPeerId(): string | null {
  const [peerId, setPeerId] = useState<string | null>(() => readHashPeerId());
  useEffect(() => {
    const handler = () => setPeerId(readHashPeerId());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return peerId;
}

function navigateToPeer(peerId: string): void {
  window.location.hash = `${PEER_HASH_PREFIX}${encodeURIComponent(peerId)}`;
}

function navigateHome(): void {
  if (typeof window === 'undefined') return;
  // history.pushState with empty hash leaves the URL clean and triggers our listener.
  history.pushState('', document.title, window.location.pathname + window.location.search);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function NetworkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M6.6 6.6l3.7 3.7M17.4 6.6l-3.7 3.7M6.6 17.4l3.7-3.7M17.4 17.4l-3.7-3.7" />
    </svg>
  );
}

function PeersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15 20c0-2.5 1.6-4.6 4-5.4" />
    </svg>
  );
}

function AntSeedMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1" />
    </svg>
  );
}

export function App() {
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const now = useTick(1000);
  const [theme, toggleTheme] = useTheme();
  const [route, setRoute] = useRoute();
  const hashPeerId = useHashPeerId();

  const updatedAtMs = data ? parseUpdatedAt(data.updatedAt) : null;
  const hasUpdate = updatedAtMs != null;
  const activeRoute: Route = hashPeerId ? 'peers' : route;
  const goToTab = (r: Route) => {
    setRoute(r);
    if (hashPeerId) navigateHome();
  };

  const nextRefreshAt = updatedAtMs != null ? updatedAtMs + SERVER_POLL_INTERVAL_MS : null;
  const secondsUntilNext =
    nextRefreshAt != null ? Math.max(0, Math.ceil((nextRefreshAt - now) / 1000)) : null;

  const routeMeta: Record<Route, { title: string; subtitle: string }> = {
    network: {
      title: 'Network',
      subtitle:
        'Live snapshot of the AntSeed peer-to-peer AI network — who is online, what they offer, and how the swarm is moving.',
    },
    peers: {
      title: 'Peers',
      subtitle: 'Every node we have heard from in the latest poll, with its on-chain accounting.',
    },
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark"><AntSeedMark /></span>
          <span className="sidebar-brand-name">AntSeed</span>
        </div>
        <nav className="sidebar-nav">
          <button
            type="button"
            className={`sidebar-nav-item${activeRoute === 'network' ? ' is-active' : ''}`}
            onClick={() => goToTab('network')}
          >
            <NetworkIcon />
            <span>Network</span>
          </button>
          <button
            type="button"
            className={`sidebar-nav-item${activeRoute === 'peers' ? ' is-active' : ''}`}
            onClick={() => goToTab('peers')}
          >
            <PeersIcon />
            <span>Peers</span>
            {data && (
              <span className="sidebar-nav-badge">{data.peers.length}</span>
            )}
          </button>
        </nav>
        <div className="sidebar-foot">
          <span>Network observatory</span>
          <span className="dim">v{new Date().getFullYear()}</span>
        </div>
      </aside>

      <div className="dash-main">
      <header className="dash-topbar">
        <div className="dash-topbar-titles">
          <h1 className="dash-topbar-title">{routeMeta[activeRoute].title}</h1>
          <p className="dash-topbar-subtitle">{routeMeta[activeRoute].subtitle}</p>
        </div>
        <div className="dash-topbar-right">
          <span
            className={`status-pill${
              hasUpdate ? (isFetching ? ' status-pill--live' : '') : ' status-pill--idle'
            }`}
          >
            <span className="status-pill-section">
              <span className="status-pill-dot" />
              <span>
                {hasUpdate
                  ? `Updated ${formatRelative(updatedAtMs, now)}`
                  : 'Awaiting first poll'}
              </span>
            </span>
            {hasUpdate && (
              <>
                <span className="status-pill-divider" aria-hidden />
                <span className="status-pill-section status-pill-section--next">
                  {isFetching || secondsUntilNext === 0
                    ? 'Refreshing…'
                    : `Next in ${formatSeconds(secondsUntilNext!)}`}
                </span>
              </>
            )}
          </span>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
        </div>
      </header>

      {hashPeerId ? (
        <PeerPage peerId={hashPeerId} onBack={navigateHome} />
      ) : (
      <main className="dash-content fade-in">
        {isLoading && <div className="status-banner">Listening for the network…</div>}
        {error && (
          <div className="status-banner status-banner--error">
            Error: {(error as Error).message}
          </div>
        )}

        {data && route === 'network' && (
          <>
            <section className="dashboard-section">
              <SectionHead
                eyebrow="Overview"
                title="Network at a glance"
                sub="Live peer count and lifetime totals from the chain."
              />
              <div className="stat-grid">
                <StatCard
                  label="Active peers"
                  value={data.peers.length}
                  hint="Nodes currently announced in the DHT."
                  accent
                />
                <StatCard
                  label="Sellers on-chain"
                  value={data.totals ? formatLargeNumber(data.totals.sellerCount) : '—'}
                  hint="Registered identities ever observed."
                />
                <StatCard
                  label="Lifetime settlements"
                  value={
                    data.totals ? formatLargeNumber(data.totals.settlementCount) : '—'
                  }
                  hint="Payment-channel close events recorded on-chain."
                />
                <StatCard
                  label="Last refresh"
                  value={hasUpdate ? formatRelative(updatedAtMs, now) : '—'}
                  hint={
                    hasUpdate
                      ? new Date(updatedAtMs!).toISOString().slice(11, 19) + 'Z'
                      : 'No poll yet'
                  }
                />
              </div>
            </section>

            {data.totals && (
              <section className="dashboard-section">
                <SectionHead
                  eyebrow="Throughput"
                  title="Lifetime activity"
                  sub="Cumulative on-chain counts across all peers since genesis."
                />
                <div className="stat-grid stat-grid--3">
                  <StatCard
                    label="Requests served"
                    value={formatLargeNumber(data.totals.totalRequests)}
                    hint="Cumulative on-chain count."
                  />
                  <StatCard
                    label="Input tokens"
                    value={formatLargeNumber(data.totals.totalInputTokens)}
                    hint="Sent into models, all peers."
                  />
                  <StatCard
                    label="Output tokens"
                    value={formatLargeNumber(data.totals.totalOutputTokens)}
                    hint="Generated back to buyers."
                  />
                </div>
              </section>
            )}

            {data.indexer && (
              <section className="dashboard-section">
                <SectionHead
                  eyebrow="Indexer"
                  title="Chain reader"
                  sub="The component that produces these numbers — how fresh its view is."
                />
                <div className="card">
                  <div className="indexer-grid">
                    <div className="indexer-field">
                      <span className="stat-card-label">Chain</span>
                      <span className="indexer-val">{data.indexer.chainId}</span>
                    </div>
                    <div className="indexer-field">
                      <span className="stat-card-label">Block</span>
                      <span className="indexer-val">
                        {data.indexer.lastBlock.toLocaleString()}
                        {data.indexer.latestBlock != null && (
                          <span className="dim">
                            {' / '}
                            {data.indexer.latestBlock.toLocaleString()}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="indexer-field">
                      <span className="stat-card-label">Status</span>
                      <span className="indexer-val">
                        <span
                          className={`status-tag ${
                            data.indexer.synced ? 'status-tag--ok' : 'status-tag--warn'
                          }`}
                        >
                          {data.indexer.synced ? 'synced' : 'syncing'}
                        </span>
                      </span>
                    </div>
                  </div>
                  {data.indexer.latestBlock != null && data.indexer.latestBlock > 0 && (
                    <div className="indexer-bar">
                      <div
                        className="indexer-bar-fill"
                        style={{
                          width: `${Math.min(
                            100,
                            (data.indexer.lastBlock / data.indexer.latestBlock) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </section>
            )}

            {data.network && (
              <>
                <section className="dashboard-section">
                  <SectionHead
                    eyebrow="Stake"
                    title="Skin in the game"
                    sub="USDC each peer has locked into the protocol — more stake means more to lose for misbehaviour."
                  />
                  {data.network.stake ? (
                    <div className="stat-grid">
                      <StatCard
                        label="Locked total"
                        value={formatUsd(data.network.stake.totalUsdc)}
                        hint="Sum across every peer that reports stake."
                        accent
                      />
                      <StatCard
                        label="Median peer"
                        value={formatUsd(data.network.stake.medianUsdc)}
                        hint="Half the peers stake more, half less."
                      />
                      <StatCard
                        label="Top 5%"
                        value={formatUsd(data.network.stake.p95Usdc)}
                        hint="Only 1 in 20 peers stake more than this."
                      />
                      <StatCard
                        label="Peers staked"
                        value={String(data.network.stake.peersWithStake)}
                        hint="How many peers have any stake on-chain."
                      />
                    </div>
                  ) : (
                    <div className="card empty-cell">No peers report stake yet.</div>
                  )}
                </section>

                <section className="dashboard-section">
                  <SectionHead
                    eyebrow="Heartbeat"
                    title="Freshness"
                    sub="Peers re-announce themselves to the DHT on a schedule. These four numbers describe how recently we heard from each one."
                  />
                  {data.network.freshness ? (
                    <div className="stat-grid">
                      <StatCard
                        label="Most recent"
                        value={formatSeconds(data.network.freshness.newestAgeSeconds)}
                        hint="The freshest peer announced this long ago."
                        accent
                      />
                      <StatCard
                        label="Half within"
                        value={formatSeconds(data.network.freshness.medianAgeSeconds)}
                        hint="50% of peers checked in within this window."
                      />
                      <StatCard
                        label="95% within"
                        value={formatSeconds(data.network.freshness.p95AgeSeconds)}
                        hint="Only 1 in 20 peers is staler than this."
                      />
                      <StatCard
                        label="Stalest"
                        value={formatSeconds(data.network.freshness.oldestAgeSeconds)}
                        hint="The oldest record we still hold for any peer."
                      />
                    </div>
                  ) : (
                    <div className="card empty-cell">No usable timestamps yet.</div>
                  )}
                </section>

                <section className="dashboard-section">
                  <SectionHead
                    eyebrow="Distributions"
                    title="Service mix"
                    sub="The shape of the network right now — which AI services peers offer, grouped both finely and by family."
                  />
                  <div className="histogram-grid">
                    <Histogram
                      title="Services"
                      caption="Each AI service advertised by at least one peer (e.g. chat, embed)."
                      data={data.network.serviceCounts}
                    />
                    <Histogram
                      title="Categories"
                      caption="Higher-level service families peers participate in (coding, TEE, …)."
                      data={data.network.serviceCategoryCounts}
                    />
                  </div>
                </section>
              </>
            )}

            <footer className="dash-footer">
              <span>AntSeed · {new Date().getFullYear()}</span>
              <span>Read-only network observatory</span>
            </footer>
          </>
        )}

        {data && route === 'peers' && (
          <>
            <section className="dashboard-section">
              <SectionHead
                eyebrow="Peers"
                title="The swarm"
                sub="Every node we have heard from in the latest poll, with its on-chain accounting attached."
              />
              {data.network && (
                <div className="peer-aside">
                  <span className="peer-aside-pill">
                    <code>{data.network.peersWithSellerContract}</code>
                    &nbsp;of&nbsp;<code>{data.peers.length}</code> carry an on-chain seller
                    contract
                  </span>
                  <span className="peer-aside-pill">
                    <code>{data.network.peersWithDisplayName}</code> announce a display name
                  </span>
                </div>
              )}
              {data.peers.length === 0 ? (
                <div className="card empty-cell">
                  No peers discovered yet — the DHT poll runs every 15 minutes after a 15s
                  warmup. Sit tight.
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="peer-table">
                    <thead>
                      <tr>
                        <th>Peer</th>
                        <th>Services</th>
                        <th>Requests</th>
                        <th>Input tokens</th>
                        <th>Output tokens</th>
                        <th>Buyers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.peers]
                        .sort((a, b) => {
                          const aReq = Number(a.onChainStats?.totalRequests ?? 0);
                          const bReq = Number(b.onChainStats?.totalRequests ?? 0);
                          if (aReq !== bReq) return bReq - aReq;
                          const aSvc = a.services?.length ?? 0;
                          const bSvc = b.services?.length ?? 0;
                          if (aSvc !== bSvc) return bSvc - aSvc;
                          return a.peerId.localeCompare(b.peerId);
                        })
                        .map((p) => {
                        const id = shortPeerId(p.peerId);
                        const services = p.services ?? [];
                        const stats = p.onChainStats;
                        return (
                          <tr
                            key={p.peerId}
                            className="peer-row"
                            tabIndex={0}
                            role="link"
                            onClick={() => navigateToPeer(p.peerId)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                navigateToPeer(p.peerId);
                              }
                            }}
                          >
                            <td>
                              <span className="peer-id">
                                {id.head}
                                {id.tail && (
                                  <>
                                    <span className="dim">…</span>
                                    {id.tail}
                                  </>
                                )}
                              </span>
                            </td>
                            <td>
                              {services.length === 0 ? (
                                <span className="em-dash">—</span>
                              ) : (
                                <span className="svc-tags">
                                  {services.map((s) => (
                                    <span key={s} className="svc-tag">
                                      {s}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </td>
                            <td className="num">
                              {stats ? (
                                formatLargeNumber(stats.totalRequests)
                              ) : (
                                <span className="em-dash">—</span>
                              )}
                            </td>
                            <td className="num">
                              {stats ? (
                                formatLargeNumber(stats.totalInputTokens)
                              ) : (
                                <span className="em-dash">—</span>
                              )}
                            </td>
                            <td className="num">
                              {stats ? (
                                formatLargeNumber(stats.totalOutputTokens)
                              ) : (
                                <span className="em-dash">—</span>
                              )}
                            </td>
                            <td className="num">
                              {stats ? (
                                formatLargeNumber(stats.uniqueBuyers)
                              ) : (
                                <span className="em-dash">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

          </>
        )}
      </main>
      )}
      </div>
    </div>
  );
}
