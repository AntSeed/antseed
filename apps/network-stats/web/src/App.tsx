import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchStats, type Peer } from './api';
import { AntSeedMark, NetworkIcon, PeersIcon } from './components/icons';
import { NetworkOverview } from './components/NetworkOverview';
import { PeersTable } from './components/PeersTable';
import { PeerServicesModal } from './components/PeerServicesModal';
import { TelemetryModal } from './components/TelemetryModal';
import { PeerPage } from './PeerPage';
import {
  formatRelative,
  formatSeconds,
  MoonIcon,
  parseUpdatedAt,
  SectionHead,
  SunIcon,
  useTheme,
  useTick,
} from './utils';

/* ─────────────────────────────────────────────────────────── */

const REFETCH_INTERVAL_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 15 * 60 * 1000;

type Route = 'network' | 'peers';
const PEER_HASH_PREFIX = '#/peer/';

interface HashRoute {
  route: Route;
  peerId: string | null;
}

function readHashRoute(): HashRoute {
  if (typeof window === 'undefined') return { route: 'network', peerId: null };
  const h = window.location.hash;
  if (h.startsWith(PEER_HASH_PREFIX)) {
    const id = decodeURIComponent(h.slice(PEER_HASH_PREFIX.length));
    return id.length > 0 ? { route: 'peers', peerId: id } : { route: 'peers', peerId: null };
  }
  if (h === '#/peers') return { route: 'peers', peerId: null };
  return { route: 'network', peerId: null };
}

function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<HashRoute>(() => readHashRoute());
  useEffect(() => {
    const handler = () => setRoute(readHashRoute());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return route;
}

function navigateToPeer(peerId: string): void {
  window.location.hash = `${PEER_HASH_PREFIX}${encodeURIComponent(peerId)}`;
}

function navigateToTab(route: Route): void {
  if (typeof window === 'undefined') return;
  window.location.hash = route === 'peers' ? '#/peers' : '#/';
}

export function App() {
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const now = useTick(1000);
  const [theme, toggleTheme] = useTheme();
  const { route, peerId: hashPeerId } = useHashRoute();
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [servicesModal, setServicesModal] = useState<{ peer: Peer; services: string[] } | null>(
    null,
  );

  const updatedAtMs = data ? parseUpdatedAt(data.updatedAt) : null;
  const hasUpdate = updatedAtMs != null;
  const activeRoute: Route = route;

  // Indexer is "degraded" when its most recent tick threw — typically a flaky
  // public Base RPC timing out on eth_getLogs. The next tick replays the same
  // checkpoint, so this is a soft signal: data isn't lost, it's just stalled.
  const indexer = data?.indexer;
  const indexerDegraded =
    indexer != null
    && indexer.lastErrorAt != null
    && (indexer.lastSuccessAt == null || indexer.lastErrorAt > indexer.lastSuccessAt);

  const nextRefreshAt = updatedAtMs != null ? updatedAtMs + SERVER_POLL_INTERVAL_MS : null;
  const secondsUntilNext =
    nextRefreshAt != null ? Math.max(0, Math.ceil((nextRefreshAt - now) / 1000)) : null;

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
            onClick={() => navigateToTab('network')}
          >
            <NetworkIcon />
            <span>Network</span>
          </button>
          <button
            type="button"
            className={`sidebar-nav-item${activeRoute === 'peers' ? ' is-active' : ''}`}
            onClick={() => navigateToTab('peers')}
          >
            <PeersIcon />
            <span>Peers</span>
            {data && (
              <span className="sidebar-nav-badge">{data.peers.length}</span>
            )}
          </button>
        </nav>
        <div className="sidebar-foot">
          <dl
            className="telemetry-panel"
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-expanded={telemetryOpen}
            aria-label="Open station telemetry"
            onClick={() => setTelemetryOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setTelemetryOpen(true);
              }
            }}
          >
            <div
              className={`telemetry-row${
                hasUpdate ? (isFetching ? ' telemetry-row--live' : '') : ' telemetry-row--idle'
              }`}
            >
              <span className="telemetry-dot" aria-hidden />
              <dt className="telemetry-label">Updated</dt>
              <dd className="telemetry-value">
                {hasUpdate ? formatRelative(updatedAtMs, now) : 'awaiting'}
              </dd>
            </div>
            {hasUpdate && (
              <div className="telemetry-row telemetry-row--ghost">
                <span className="telemetry-dot" aria-hidden />
                <dt className="telemetry-label">Next</dt>
                <dd className="telemetry-value">
                  {isFetching || secondsUntilNext === 0
                    ? 'refreshing…'
                    : `in ${formatSeconds(secondsUntilNext!)}`}
                </dd>
              </div>
            )}
            {indexer && (() => {
              const indexerTitle = indexerDegraded
                ? indexer.lastErrorMessage
                  ? `Latest RPC error: ${indexer.lastErrorMessage}`
                  : 'Latest indexer tick failed — retrying on next interval.'
                : 'Chain indexer is keeping up with the latest blocks.';
              return (
                <div
                  className={`telemetry-row${
                    indexerDegraded ? ' telemetry-row--alert' : ' telemetry-row--ok'
                  }`}
                >
                  <span className="telemetry-dot" aria-hidden title={indexerTitle} />
                  <dt className="telemetry-label" title={indexerTitle}>Indexer</dt>
                  <dd className="telemetry-value" title={indexerTitle}>
                    <span className="telemetry-value-main">
                      {indexerDegraded ? 'RPC issues' : 'healthy'}
                    </span>
                    {indexerDegraded && indexer.lastErrorAt != null && (
                      <span className="telemetry-value-aside">
                        {formatRelative(indexer.lastErrorAt, now)}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })()}
          </dl>
          <div className="sidebar-foot-meta">
            <button
              type="button"
              className="theme-toggle theme-toggle--mini"
              onClick={toggleTheme}
              aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
              title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            >
              {theme === 'light' ? <MoonIcon /> : <SunIcon />}
              <span className="theme-toggle-label">{theme} mode</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="dash-main">
      {hashPeerId ? (
        <PeerPage peerId={hashPeerId} onBack={() => navigateToTab('peers')} />
      ) : (
      <main className="dash-content fade-in">
        {isLoading && <div className="status-banner">Listening for the network…</div>}
        {error && (
          <div className="status-banner status-banner--error">
            Error: {(error as Error).message}
          </div>
        )}

        {data && route === 'network' && (
          <NetworkOverview
            data={data}
            now={now}
            updatedAtMs={updatedAtMs}
            hasUpdate={hasUpdate}
            indexerDegraded={indexerDegraded}
          />
        )}

        {data && route === 'peers' && (
          <>
            <section className="dashboard-section">
              <SectionHead
                title="Peers"
                sub="Every node we have heard from in the latest poll, with its on-chain accounting attached."
              />
              {data.peers.length === 0 ? (
                <div className="card empty-cell">
                  No peers discovered yet — the DHT poll runs every 15 minutes after a 15s
                  warmup. Sit tight.
                </div>
              ) : (
                <PeersTable
                  peers={data.peers}
                  onNavigatePeer={navigateToPeer}
                  onOpenServices={(peer, services) => setServicesModal({ peer, services })}
                />
              )}
            </section>

          </>
        )}
      </main>
      )}
      </div>
      {telemetryOpen && (
        <TelemetryModal
          updatedAtMs={updatedAtMs}
          isFetching={isFetching}
          secondsUntilNext={secondsUntilNext}
          serverPollMs={SERVER_POLL_INTERVAL_MS}
          indexer={indexer ?? null}
          indexerDegraded={indexerDegraded}
          now={now}
          onClose={() => setTelemetryOpen(false)}
        />
      )}
      {servicesModal && (
        <PeerServicesModal
          peer={servicesModal.peer}
          services={servicesModal.services}
          onClose={() => setServicesModal(null)}
        />
      )}
    </div>
  );
}
