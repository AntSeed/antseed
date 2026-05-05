import { useMemo, useState } from 'react';
import type {
  Activity,
  ConcentrationStats,
  InsightsResponse,
  RegionDistributionEntry,
  ServicePricingMarket,
  ServiceRanking,
  Velocity,
  VelocityWindow,
} from '../api';
import { formatLargeNumber, SectionHead, StatCard } from '../utils';
import { Histogram } from './Histogram';
import { PriceMovements } from './PriceMovements';

function formatGrowth(pct: number | null): string {
  if (pct == null) return '—';
  if (pct === -1) return 'new';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${(pct * 100).toFixed(1)}%`;
}

function formatRatio(value: number | null, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function ActivitySection({ activity }: { activity: Activity }) {
  return (
    <section className="dashboard-section">
      <SectionHead
        title="Activity"
        sub="Online presence right now and the slice of indexed sellers that recently transacted."
      />
      <div className="stat-grid stat-grid--3">
        <StatCard
          label="Peers online"
          value={formatLargeNumber(activity.peersOnline)}
          hint="Live peers in the latest DHT poll."
          accent
        />
        <StatCard
          label="Active in last 24h"
          value={formatLargeNumber(activity.sellersActiveLast24h)}
          hint="Indexed sellers with at least one settlement in the last 24h."
        />
        <StatCard
          label="Sellers indexed"
          value={formatLargeNumber(activity.totalSellersIndexed)}
          hint="Distinct on-chain identities ever observed."
        />
      </div>
    </section>
  );
}

function VelocityCard({ window, label }: { window: VelocityWindow | null; label: string }) {
  if (!window) {
    return (
      <div className="velocity-card">
        <div className="velocity-card-head">{label}</div>
        <div className="velocity-card-empty">Not enough history yet.</div>
      </div>
    );
  }
  return (
    <div className="velocity-card">
      <div className="velocity-card-head">{label}</div>
      <div className="velocity-card-grid">
        <div className="velocity-stat">
          <span className="velocity-stat-label">Requests</span>
          <span className="velocity-stat-value">{formatLargeNumber(window.requestsDelta)}</span>
          <span className="velocity-stat-aside">{formatGrowth(window.requestsGrowthPct)}</span>
        </div>
        <div className="velocity-stat">
          <span className="velocity-stat-label">Tokens</span>
          <span className="velocity-stat-value">{formatLargeNumber(window.tokensDelta)}</span>
        </div>
        <div className="velocity-stat">
          <span className="velocity-stat-label">Settlements</span>
          <span className="velocity-stat-value">{formatLargeNumber(window.settlementsDelta)}</span>
        </div>
      </div>
    </div>
  );
}

function VelocitySection({ velocity }: { velocity: Velocity }) {
  return (
    <section className="dashboard-section">
      <SectionHead
        title="Velocity"
        sub="Cumulative on-chain deltas over the last 24h and 7d, with period-over-period growth."
      />
      <div className="velocity-grid">
        <VelocityCard window={velocity.last24h} label="Last 24 hours" />
        <VelocityCard window={velocity.last7d} label="Last 7 days" />
      </div>
    </section>
  );
}

function ConcentrationSection({ data }: { data: ConcentrationStats }) {
  return (
    <section className="dashboard-section">
      <SectionHead
        title="Concentration"
        sub="How evenly demand is spread across sellers. Lower numbers mean a healthier market."
      />
      <div className="stat-grid stat-grid--3">
        <StatCard
          label="Gini"
          value={formatRatio(data.gini)}
          hint={`0 = even split, 1 = monopoly. n=${data.sellerCount}.`}
        />
        <StatCard
          label="Herfindahl (HHI)"
          value={formatRatio(data.herfindahl)}
          hint="Sum of squared request shares."
        />
        <StatCard
          label="Top 10 share"
          value={formatPercent(data.top10Share)}
          hint="Share of total requests captured by the top-10 sellers."
        />
      </div>
    </section>
  );
}

function PricingSection({ byService }: { byService: Record<string, ServicePricingMarket> }) {
  const [showAll, setShowAll] = useState(false);
  const entries = useMemo(
    () =>
      Object.entries(byService).sort(
        ([keyA, a], [keyB, b]) => b.peerCount - a.peerCount || keyA.localeCompare(keyB),
      ),
    [byService],
  );
  const limit = 8;
  const visible = showAll ? entries : entries.slice(0, limit);
  const hidden = entries.length - limit;

  return (
    <section className="dashboard-section">
      <SectionHead
        title="Pricing market"
        sub="Per-service price distribution across peers, and the cheapest peer per service."
      />
      {entries.length === 0 ? (
        <div className="card empty-cell">No pricing announced yet.</div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="peer-table pricing-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th className="num">Peers</th>
                  <th className="num">Median input</th>
                  <th className="num">Median output</th>
                  <th className="num">Cheapest input</th>
                  <th>Cheapest peer</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(([service, market]) => (
                  <tr key={service}>
                    <td><span className="svc-tag">{service}</span></td>
                    <td className="num">{market.peerCount}</td>
                    <td className="num">{formatPrice(market.input.median)}</td>
                    <td className="num">{formatPrice(market.output.median)}</td>
                    <td className="num">{formatPrice(market.cheapestInputUsdPerMillion)}</td>
                    <td className="pricing-peer">
                      {market.cheapestPeerId ? (
                        <code>{market.cheapestPeerId.slice(0, 10)}…</code>
                      ) : (
                        <span className="em-dash">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hidden > 0 && (
            <button
              type="button"
              className="histogram-toggle"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show less' : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function rankToHistogramData(ranking: ServiceRanking[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { key, peers } of ranking) out[key] = peers;
  return out;
}

function regionsToHistogramData(regions: RegionDistributionEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { region, peers } of regions) out[region] = peers;
  return out;
}

function ServicesSection({ services }: { services: InsightsResponse['services'] }) {
  return (
    <section className="dashboard-section">
      <SectionHead
        title="Network composition"
        sub="What protocols and providers peers run, beyond the basic service histogram."
      />
      <div className="histogram-grid">
        <Histogram
          title="Providers"
          caption="Provider implementations announced by peers (anthropic, openai, …)."
          data={rankToHistogramData(services.topProviders)}
        />
        <Histogram
          title="Protocols"
          caption="API protocols peers expose (responses, anthropic, openai, …)."
          data={rankToHistogramData(services.topProtocols)}
        />
      </div>
    </section>
  );
}

function RegionsSection({ regions }: { regions: RegionDistributionEntry[] }) {
  return (
    <section className="dashboard-section">
      <SectionHead
        title="Regions"
        sub="Where peers are physically located, as self-reported in the DHT announcement."
      />
      {regions.length === 0 ? (
        <div className="card empty-cell">No regions reported yet.</div>
      ) : (
        <div className="histogram-grid">
          <Histogram
            title="Peers by region"
            caption="Each peer counts once toward its announced region."
            data={regionsToHistogramData(regions)}
          />
        </div>
      )}
    </section>
  );
}

export function Insights({ data }: { data: InsightsResponse }) {
  return (
    <>
      <ActivitySection activity={data.activity} />
      <VelocitySection velocity={data.velocity} />
      <ConcentrationSection data={data.concentration} />
      <PricingSection byService={data.pricing.byService} />
      <PriceMovements stability={data.priceStability} movers={data.priceMovers} />
      <ServicesSection services={data.services} />
      <RegionsSection regions={data.regions} />
    </>
  );
}
