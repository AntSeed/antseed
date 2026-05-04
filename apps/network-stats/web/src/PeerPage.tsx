import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchStats, getPeerServices, type Peer, type ProviderAnnouncement } from './api';
import { SearchGlyph } from './components/icons';
import { Modal } from './components/Modal';
import {
  formatAbsolute,
  formatNumberFull,
  formatPrefixedAddress,
  formatLargeNumber,
  formatRelative,
  formatRelativeSeconds,
  formatUsd,
  parseUpdatedAt,
  shortPeerId,
  SectionHead,
  StatCard,
  useTick,
} from './utils';

const REFETCH_INTERVAL_MS = 30_000;
const SERVICES_PREVIEW_LIMIT = 18;
const PROVIDER_GROUP_PREVIEW_LIMIT = 10;

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

      {peer && <PeerDetail peer={peer} chainId={data?.indexer?.chainId} now={now} />}
    </main>
  );
}

function PeerDetail({ peer, chainId, now }: { peer: Peer; chainId?: string; now: number }) {
  const id = shortPeerId(peer.peerId);
  const stats = peer.onChainStats;
  const services = getPeerServices(peer);
  const endpoints = peer.endpoints ?? [];
  const providers = peer.providers ?? [];
  const announceMs = peer.timestamp ?? null;

  const sellerContractFmt = formatPrefixedAddress(peer.sellerContract);
  const publicAddressFmt = formatPrefixedAddress(peer.publicAddress);

  return (
    <>
      <header className="peer-page-head">
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
          {chainId && <span className="peer-page-meta-pill">{chainId}</span>}
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
          title="Activity"
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
          title="Identity"
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
              {formatRelative(announceMs, now)} <span className="dim">({formatAbsolute(announceMs)})</span>
            </KV>
          )}
        </div>
      </section>

      <section className="dashboard-section">
        <SectionHead
          title="Services"
          sub="What this peer advertises to buyers."
        />
        <ServicesPanel services={services} providers={providers} />
      </section>

      {endpoints.length > 0 && (
        <section className="dashboard-section">
          <SectionHead
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
            title="On-chain history"
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
              {formatRelativeSeconds(stats.firstSeenAt, now)}
              {stats.firstSeenAt && (
                <span className="dim"> ({formatAbsolute(stats.firstSeenAt * 1000)})</span>
              )}
            </KV>
            <KV label="Last seen">
              {formatRelativeSeconds(stats.lastSeenAt, now)}
              {stats.lastSeenAt && (
                <span className="dim"> ({formatAbsolute(stats.lastSeenAt * 1000)})</span>
              )}
            </KV>
            <KV label="Indexer last touched">
              {formatRelativeSeconds(stats.lastUpdatedAt, now)}
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

/* ── Services panel ────────────────────────────────────────────────
   Renders peer-announced capabilities and provider manifests. Model IDs
   are grouped by family so long service names stay readable. */

function parseService(s: string): { family: string; version: string | null } {
  const idx = s.lastIndexOf('-');
  if (idx > 0 && /^\d/.test(s.slice(idx + 1))) {
    return { family: s.slice(0, idx), version: s.slice(idx + 1) };
  }
  return { family: s, version: null };
}

interface ServiceGroup {
  family: string;
  versions: string[];
}

function groupByFamily(services: string[]): ServiceGroup[] {
  const map = new Map<string, ServiceGroup>();
  const order: string[] = [];
  for (const s of services) {
    const { family, version } = parseService(s);
    let group = map.get(family);
    if (!group) {
      group = { family, versions: [] };
      map.set(family, group);
      order.push(family);
    }
    if (version) group.versions.push(version);
  }
  return order.map((k) => map.get(k)!);
}

function ServicesPanel({
  services,
  providers,
}: {
  services: string[];
  providers: ProviderAnnouncement[];
}) {
  const [modal, setModal] = useState<{ title: string; meta: string; services: string[] } | null>(
    null,
  );

  if (services.length === 0 && providers.length === 0) {
    return <div className="card empty-cell">No services announced.</div>;
  }
  const totalModels = providers.reduce(
    (sum, p) => sum + (p.services?.length ?? 0),
    0,
  );
  const visibleServices = services.slice(0, SERVICES_PREVIEW_LIMIT);
  const hiddenServices = Math.max(0, services.length - SERVICES_PREVIEW_LIMIT);

  return (
    <>
      <div className="card services-card">
        {services.length > 0 && (
          <div className="services-block">
            <ServicesBlockHead
              title="Capabilities"
              meta={`${services.length} ${services.length === 1 ? 'service' : 'services'}`}
            />
            <div className="services-capabilities services-capabilities--preview">
              {visibleServices.map((s) => (
                <span key={s} className="capability-chip">{s}</span>
              ))}
              {hiddenServices > 0 && (
                <button
                  type="button"
                  className="services-more"
                  onClick={() => setModal({
                    title: 'Capabilities',
                    meta: `${services.length} ${services.length === 1 ? 'service' : 'services'}`,
                    services,
                  })}
                >
                  View all {services.length}
                </button>
              )}
            </div>
          </div>
      )}
      {providers.length > 0 && (
        <div className="services-block">
          <ServicesBlockHead
            title="Providers"
            meta={[
              `${providers.length} ${providers.length === 1 ? 'provider' : 'providers'}`,
              totalModels > 0 ? `${totalModels} ${totalModels === 1 ? 'model' : 'models'}` : null,
            ].filter(Boolean).join(' · ')}
          />
          <div className="services-providers">
            {providers.map((p, i) => (
              <ProviderManifest
                key={p.providerId ?? p.provider ?? `idx-${i}`}
                provider={p}
                index={i}
                onViewAll={(title, providerServices) => setModal({
                  title,
                  meta: `${providerServices.length} ${providerServices.length === 1 ? 'model' : 'models'}`,
                  services: providerServices,
                })}
              />
            ))}
          </div>
        </div>
      )}
      </div>
      {modal && (
        <ServicesModal
          title={modal.title}
          meta={modal.meta}
          services={modal.services}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

function ServicesBlockHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="services-block-head">
      <h3 className="services-block-title">{title}</h3>
      {meta && <span className="services-block-meta">{meta}</span>}
    </div>
  );
}

function ProviderManifest({
  provider,
  index,
  onViewAll,
}: {
  provider: ProviderAnnouncement;
  index: number;
  onViewAll: (title: string, services: string[]) => void;
}) {
  const services = provider.services ?? [];
  const providerName = provider.provider ?? provider.providerId ?? `provider ${index + 1}`;
  const groups = groupByFamily(services);
  const visibleGroups = groups.slice(0, PROVIDER_GROUP_PREVIEW_LIMIT);
  const hiddenGroups = Math.max(0, groups.length - PROVIDER_GROUP_PREVIEW_LIMIT);
  const hasVersions = groups.some((g) => g.versions.length > 0);

  return (
    <div className="provider-manifest">
      <div className="provider-manifest-head">
        <code className="mono">{providerName}</code>
        <span>
          {services.length} {services.length === 1 ? 'model' : 'models'}
        </span>
      </div>
      {services.length > 0 && (
        hasVersions ? (
          <ul className="model-rows">
            {visibleGroups.map((g) => (
              <li key={g.family} className="model-row">
                <span className="model-row-family">{g.family}</span>
                <span className="model-row-versions">
                  {g.versions.length === 0 ? (
                    <span className="model-version model-version--none">No version</span>
                  ) : g.versions.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="provider-manifest-pills">
            {services.slice(0, SERVICES_PREVIEW_LIMIT).map((s) => (
              <span key={s} className="capability-chip">{s}</span>
            ))}
          </div>
        )
      )}
      {(hiddenGroups > 0 || services.length > SERVICES_PREVIEW_LIMIT) && (
        <button
          type="button"
          className="provider-manifest-more"
          onClick={() => onViewAll(providerName, services)}
        >
          View all {services.length} models
        </button>
      )}
    </div>
  );
}

function ServicesModal({
  title,
  meta,
  services,
  onClose,
}: {
  title: string;
  meta: string;
  services: string[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const showSearch = services.length > 12;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return services;
    return services.filter((s) => s.toLowerCase().includes(q));
  }, [query, services]);

  return (
    <Modal
      variant="services"
      titleId="services-modal-title"
      eyebrow="Catalogue"
      title={title}
      sub={meta}
      onClose={onClose}
    >
      {showSearch && (
        <div className="services-modal-search">
          <SearchGlyph />
          <input
            type="text"
            placeholder="Filter services…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            aria-label="Filter services"
          />
          {query && (
            <button
              type="button"
              className="services-modal-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear filter"
            >
              ×
            </button>
          )}
        </div>
      )}

      <div className="services-modal-body">
        {filtered.length === 0 ? (
          <div className="services-modal-empty">
            No services match <code className="mono">{query}</code>.
          </div>
        ) : (
          filtered.map((service) => (
            <span key={service} className="capability-chip">{service}</span>
          ))
        )}
      </div>

      <footer className="services-modal-foot">
        <span className="services-modal-foot-count">
          {query ? (
            <>
              <strong>{filtered.length}</strong> of {services.length}
            </>
          ) : (
            <>
              <strong>{services.length}</strong>{' '}
              {services.length === 1 ? 'service' : 'services'}
            </>
          )}
        </span>
        <span className="services-modal-foot-hint">esc to close</span>
      </footer>
    </Modal>
  );
}
