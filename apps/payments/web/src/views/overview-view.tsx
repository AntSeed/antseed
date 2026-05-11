import type { PaymentConfig, BalanceData } from '../types';
import { type BuyerUsageChannelPoint } from '../lib/api';
import { useBuyerUsage, useNetworkStats } from '../hooks/queries';
import { UsageChart } from '../components/ui/usage-chart';
import { formatCompact, formatNumber, bigintFromString } from '../lib/format';
import { OverviewHero } from './overview-hero';
import type { TabId } from '../components/layout/sidebar';
import './overview-view.scss';

interface OverviewViewProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  onOpenDeposit: () => void;
  onSelectTab: (tab: TabId) => void;
}

const EMPTY_CHANNELS: BuyerUsageChannelPoint[] = [];

export function OverviewView({ config, balance, onOpenDeposit, onSelectTab }: OverviewViewProps) {
  const networkStatsUrl = config?.networkStatsUrl ?? null;

  const { data: buyerUsage = null, error: buyerUsageErr } = useBuyerUsage();
  const { data: networkStats = null, error: networkStatsErr } = useNetworkStats(networkStatsUrl);
  const buyerUsageError = buyerUsageErr ? (buyerUsageErr instanceof Error ? buyerUsageErr.message : String(buyerUsageErr)) : null;
  const networkStatsError = networkStatsErr ? (networkStatsErr instanceof Error ? networkStatsErr.message : String(networkStatsErr)) : null;

  const personalRequests = buyerUsage?.totalRequests ?? 0;
  const personalTokens =
    bigintFromString(buyerUsage?.totalInputTokens) +
    bigintFromString(buyerUsage?.totalOutputTokens);
  const personalSettlements = buyerUsage?.totalSettlements ?? 0;
  const personalUniqueSellers = buyerUsage?.uniqueSellers ?? 0;

  const networkRequests = bigintFromString(networkStats?.totals.totalRequests);
  const networkTokens =
    bigintFromString(networkStats?.totals.totalInputTokens) +
    bigintFromString(networkStats?.totals.totalOutputTokens);
  const networkSettlements = networkStats?.totals.totalSettlements ?? 0;
  const networkPeers = networkStats?.totals.activePeers ?? 0;
  const networkSellers = networkStats?.totals.sellerCount;

  return (
    <div className="overview-view">
      <OverviewHero
        balance={balance}
        onOpenDeposit={onOpenDeposit}
        onSelectTab={onSelectTab}
      />

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Network</div>
          <h2 className="overview-section-title">Global activity</h2>
          <p className="overview-section-sub">
            Aggregate stats across every seller on the AntSeed network.
          </p>
        </header>

        {networkStats === null && networkStatsError === null && networkStatsUrl ? (
          <div className="stat-grid" aria-busy="true" aria-label="Loading network stats">
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="stat-card" key={i}>
                <span className="skel skel-line skel-line--label" />
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </div>
            ))}
          </div>
        ) : (
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-card-label">Active peers</div>
              <div className="stat-card-value">{formatNumber(networkPeers)}</div>
              <div className="stat-card-hint">
                {networkSellers != null
                  ? `${formatNumber(networkSellers)} sellers with lifetime activity`
                  : 'Sellers currently online with on-chain activity'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Network requests</div>
              <div className="stat-card-value">{formatCompact(networkRequests)}</div>
              <div className="stat-card-hint">Across all sellers</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Network settlements</div>
              <div className="stat-card-value">{formatNumber(networkSettlements)}</div>
              <div className="stat-card-hint">Total channels settled</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Network tokens</div>
              <div className="stat-card-value">{formatCompact(networkTokens)}</div>
              <div className="stat-card-hint">Input + output across all peers</div>
            </div>
          </div>
        )}

        {networkStatsError && (
          <div className="overview-stats-error">
            Couldn&apos;t load network stats: {networkStatsError}
          </div>
        )}
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Your activity</div>
          <h2 className="overview-section-title">Your usage</h2>
          <p className="overview-section-sub">
            Requests and tokens flowing through your signer over time.
          </p>
        </header>

        <div className="overview-chart-card">
          <div className="overview-kpi-row">
            <div className="overview-kpi">
              <div className="overview-kpi-label">Requests</div>
              <div className="overview-kpi-value">{formatNumber(personalRequests)}</div>
            </div>
            <div className="overview-kpi">
              <div className="overview-kpi-label">Tokens</div>
              <div className="overview-kpi-value">{formatCompact(personalTokens)}</div>
            </div>
            <div className="overview-kpi">
              <div className="overview-kpi-label">Settlements</div>
              <div className="overview-kpi-value">{formatNumber(personalSettlements)}</div>
            </div>
            <div className="overview-kpi">
              <div className="overview-kpi-label">Sellers</div>
              <div className="overview-kpi-value">{formatNumber(personalUniqueSellers)}</div>
            </div>
          </div>

          <UsageChart channels={buyerUsage?.channels ?? EMPTY_CHANNELS} />
          {buyerUsageError && (
            <div className="overview-stats-error">
              Couldn&apos;t load your usage: {buyerUsageError}
            </div>
          )}
        </div>
      </section>

    </div>
  );
}
