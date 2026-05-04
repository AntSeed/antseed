import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchStats, type Peer } from './api';
import {
  formatLargeNumber,
  formatRelative,
  formatUsd,
  parseUpdatedAt,
  shortPeerId,
  SectionHead,
  StatCard,
  useTick,
} from './utils';

const REFETCH_INTERVAL_MS = 30_000;

function formatNumberFull(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

function formatTimestampSeconds(s: number | null, now: number): string {
  if (s == null || !Number.isFinite(s) || s === 0) return '—';
  return formatRelative(s * 1000, now);
}

function formatAbsoluteSeconds(s: number | null): string {
  if (s == null || !Number.isFinite(s) || s === 0) return '—';
  return new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function formatAbsoluteMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms === 0) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function formatPrefixedAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith('0x') ? value : `0x${value}`;
}

export function PeerPage({ peerId, onBack }: { peerId: string; onBack: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const now = useTick(1000);

  const peer: Peer | undefined = data?.peers.find((p) => p.peerId === peerId);
  const updatedAtMs = data ? parseUpdatedAt(data.updatedAt) : null;

  return (
    <main className="dash-content fade-in">
      <button type="button" className="back-link" onClick={onBack} aria-label="Back to swarm">
        <span aria-hidden>←</span> Back to the swarm
      </button>

      {isLoading && <div className="status-banner">Loading peer…</div>}
      {error && (
        <div className="status-banner status-banner--error">
          Error: {(error as Error).message}
        </div>
      )}

      {data && !peer && (
        <div className="status-banner">
          Peer <code>{peerId}</code> isn't in the latest poll. It may have gone offline.
          {updatedAtMs && (
            <>
              {' '}
              Last refresh {formatRelative(updatedAtMs, now)}.
            </>
          )}
        </div>
      )}

      {peer && <PeerDetail peer={peer} now={now} />}
    </main>
  );
}

function PeerDetail({ peer, now }: { peer: Peer; now: number }) {
  const id = shortPeerId(peer.peerId);
  const stats = peer.onChainStats;
  const services = peer.services ?? [];
  const endpoints = peer.endpoints ?? [];
  const providers = peer.providers ?? [];
  const announceMs = peer.timestamp ? peer.timestamp * 1000 : null;

  const sellerContractFmt = formatPrefixedAddress(peer.sellerContract);
  const publicAddressFmt = formatPrefixedAddress(peer.publicAddress);

  return (
    <>
      <header className="peer-page-head">
        <span className="dashboard-section-eyebrow">Peer</span>
        <h2 className="peer-page-title">
          {peer.displayName ? (
            <>
              {peer.displayName}
              <span className="peer-page-title-id">
                <span className="dim">·</span> {id.head}
                {id.tail && (
                  <>
                    <span className="dim">…</span>
                    {id.tail}
                  </>
                )}
              </span>
            </>
          ) : (
            <span className="peer-page-id">
              {id.head}
              {id.tail && (
                <>
                  <span className="dim">…</span>
                  {id.tail}
                </>
              )}
            </span>
          )}
        </h2>
        <code className="peer-page-fullid">{peer.peerId}</code>
        <div className="peer-page-meta">
          {peer.region && <span className="peer-page-meta-pill">{peer.region}</span>}
          {peer.version != null && (
            <span className="peer-page-meta-pill">v{peer.version}</span>
          )}
          {announceMs && (
            <span className="peer-page-meta-pill">
              announced {formatRelative(announceMs, now)}
            </span>
          )}
          {stats?.agentId != null && stats.agentId > 0 && (
            <span className="peer-page-meta-pill peer-page-meta-pill--accent">
              agent #{stats.agentId}
            </span>
          )}
        </div>
      </header>

      <section className="dashboard-section">
        <SectionHead
          eyebrow="Activity"
          title="On-chain accounting"
          sub="Cumulative settlements recorded for this seller across every payment channel."
        />
        {stats ? (
          <>
            <div className="stat-grid">
              <StatCard
                label="Requests served"
                value={formatNumberFull(stats.totalRequests)}
                hint="Total billable requests across all channels."
                accent
              />
              <StatCard
                label="Input tokens"
                value={formatNumberFull(stats.totalInputTokens)}
                hint="Tokens sent into models."
              />
              <StatCard
                label="Output tokens"
                value={formatNumberFull(stats.totalOutputTokens)}
                hint="Tokens generated back to buyers."
              />
              <StatCard
                label="Settlements"
                value={formatNumberFull(stats.settlementCount)}
                hint="On-chain payment-channel settlement events."
              />
            </div>
            <div className="stat-grid stat-grid--3">
              <StatCard
                label="Unique buyers"
                value={formatNumberFull(stats.uniqueBuyers)}
                hint="Distinct addresses that ever paid this peer."
              />
              <StatCard
                label="Unique channels"
                value={formatNumberFull(stats.uniqueChannels)}
                hint="Distinct payment channels opened with this peer."
              />
              <StatCard
                label="Avg / buyer"
                value={
                  stats.avgRequestsPerBuyer != null
                    ? formatLargeNumber(stats.avgRequestsPerBuyer)
                    : '—'
                }
                hint="Mean requests per buyer."
              />
            </div>
          </>
        ) : (
          <div className="card empty-cell">
            No on-chain activity yet — this peer hasn't settled a channel.
          </div>
        )}
      </section>

      <section className="dashboard-section">
        <SectionHead
          eyebrow="Identity"
          title="Who they say they are"
          sub="Self-announced metadata pulled from the DHT plus on-chain bindings."
        />
        <div className="card peer-kv">
          <KV label="Peer ID">
            <code className="mono">{peer.peerId}</code>
          </KV>
          {peer.displayName && (
            <KV label="Display name">{peer.displayName}</KV>
          )}
          {peer.region && <KV label="Region">{peer.region}</KV>}
          {publicAddressFmt && (
            <KV label="Operator address">
              <code className="mono">{publicAddressFmt}</code>
            </KV>
          )}
          {sellerContractFmt && (
            <KV label="Seller contract">
              <code className="mono">{sellerContractFmt}</code>
            </KV>
          )}
          {peer.stakeAmountUSDC != null && (
            <KV label="Stake">{formatUsd(peer.stakeAmountUSDC)}</KV>
          )}
          {peer.trustScore != null && (
            <KV label="Trust score">{peer.trustScore}</KV>
          )}
          {peer.version != null && <KV label="Metadata version">{peer.version}</KV>}
          {announceMs && (
            <KV label="Last announce">
              {formatRelative(announceMs, now)} <span className="dim">({formatAbsoluteMs(announceMs)})</span>
            </KV>
          )}
        </div>
      </section>

      <section className="dashboard-section">
        <SectionHead
          eyebrow="Offerings"
          title="Services"
          sub="What this peer advertises to buyers."
        />
        {services.length === 0 && providers.length === 0 ? (
          <div className="card empty-cell">No services announced.</div>
        ) : (
          <div className="card">
            {services.length > 0 && (
              <div className="peer-services-block">
                <span className="peer-services-label">Services</span>
                <span className="svc-tags">
                  {services.map((s) => (
                    <span key={s} className="svc-tag">
                      {s}
                    </span>
                  ))}
                </span>
              </div>
            )}
            {providers.length > 0 && (
              <div className="peer-services-block">
                <span className="peer-services-label">Providers</span>
                <ul className="peer-providers">
                  {providers.map((p, i) => (
                    <li key={p.providerId ?? i}>
                      <code className="mono">{p.providerId ?? `#${i}`}</code>
                      {p.services && p.services.length > 0 && (
                        <span className="svc-tags">
                          {p.services.map((s) => (
                            <span key={s} className="svc-tag">
                              {s}
                            </span>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {endpoints.length > 0 && (
        <section className="dashboard-section">
          <SectionHead
            eyebrow="Network"
            title="Endpoints"
            sub="Where buyers reach this peer."
          />
          <div className="card">
            <ul className="peer-endpoints">
              {endpoints.map((e) => (
                <li key={e}>
                  <code className="mono">{e}</code>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {stats && (
        <section className="dashboard-section">
          <SectionHead
            eyebrow="Timeline"
            title="On-chain footprint"
            sub="When this peer first appeared on-chain and when we last heard from them."
          />
          <div className="card peer-kv">
            <KV label="First settlement block">
              {stats.firstSettledBlock != null
                ? stats.firstSettledBlock.toLocaleString()
                : '—'}
            </KV>
            <KV label="Last settlement block">
              {stats.lastSettledBlock != null
                ? stats.lastSettledBlock.toLocaleString()
                : '—'}
            </KV>
            <KV label="First seen">
              {formatTimestampSeconds(stats.firstSeenAt, now)}
              {stats.firstSeenAt && (
                <span className="dim"> ({formatAbsoluteSeconds(stats.firstSeenAt)})</span>
              )}
            </KV>
            <KV label="Last seen">
              {formatTimestampSeconds(stats.lastSeenAt, now)}
              {stats.lastSeenAt && (
                <span className="dim"> ({formatAbsoluteSeconds(stats.lastSeenAt)})</span>
              )}
            </KV>
            <KV label="Indexer last touched">
              {formatTimestampSeconds(stats.lastUpdatedAt, now)}
            </KV>
          </div>
        </section>
      )}
    </>
  );
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="peer-kv-row">
      <span className="peer-kv-label">{label}</span>
      <span className="peer-kv-value">{children}</span>
    </div>
  );
}
