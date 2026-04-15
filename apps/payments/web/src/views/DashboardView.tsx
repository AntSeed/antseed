import { useEffect, useState } from 'react';
import type { PaymentConfig } from '../types';
import {
  getBuyerUsage,
  getNetworkStats,
  type BuyerUsageTotals,
  type NetworkStatsResponse,
} from '../api';
import { UsageChart } from '../components/UsageChart';
import './DashboardView.scss';

interface DashboardViewProps {
  config: PaymentConfig | null;
}

function formatNumber(n: string | number): string {
  const num = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

function formatCompact(value: string | number | bigint): string {
  const num = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '0';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString('en-US');
}

function bigintFromString(s: string | undefined): bigint {
  if (!s) return 0n;
  try { return BigInt(s); } catch { return 0n; }
}

export function DashboardView({ config }: DashboardViewProps) {
  const networkStatsUrl = config?.networkStatsUrl ?? null;

  const [buyerUsage, setBuyerUsage] = useState<BuyerUsageTotals | null>(null);
  const [networkStats, setNetworkStats] = useState<NetworkStatsResponse | null>(null);
  const [buyerUsageError, setBuyerUsageError] = useState<string | null>(null);
  const [networkStatsError, setNetworkStatsError] = useState<string | null>(null);

  // Local buyer usage — has no external dependency, so fire once on mount
  // and never re-run it when config trickles in asynchronously.
  useEffect(() => {
    let cancelled = false;
    getBuyerUsage()
      .then((totals) => {
        if (cancelled) return;
        setBuyerUsage(totals);
        setBuyerUsageError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setBuyerUsageError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Global network stats — depends on networkStatsUrl from /api/config, so
  // deferred until that's available.
  useEffect(() => {
    if (!networkStatsUrl) return;
    let cancelled = false;
    getNetworkStats(networkStatsUrl)
      .then((stats) => {
        if (cancelled) return;
        setNetworkStats(stats);
        setNetworkStatsError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setNetworkStatsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [networkStatsUrl]);

  const statsError = [
    buyerUsageError && `buyer usage — ${buyerUsageError}`,
    networkStatsError && `network stats — ${networkStatsError}`,
  ].filter(Boolean).join(' · ') || null;

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

  return (
    <div className="dashboard-view">
      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">Your activity</div>
          <h2 className="dashboard-section-title">Your usage</h2>
          <p className="dashboard-section-sub">
            Requests and tokens flowing through your signer over time.
          </p>
        </header>

        <div className="dashboard-chart-card">
          <div className="dashboard-kpi-row">
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Requests</div>
              <div className="dashboard-kpi-value">{formatNumber(personalRequests)}</div>
            </div>
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Tokens</div>
              <div className="dashboard-kpi-value">{formatCompact(personalTokens)}</div>
            </div>
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Settlements</div>
              <div className="dashboard-kpi-value">{formatNumber(personalSettlements)}</div>
            </div>
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Sellers</div>
              <div className="dashboard-kpi-value">{formatNumber(personalUniqueSellers)}</div>
            </div>
          </div>

          <UsageChart channels={buyerUsage?.channels ?? []} />
          {buyerUsageError && (
            <div className="dashboard-stats-error">
              Couldn&apos;t load your usage: {buyerUsageError}
            </div>
          )}
        </div>
      </section>

      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">Network</div>
          <h2 className="dashboard-section-title">Global activity</h2>
          <p className="dashboard-section-sub">
            Aggregate stats across every seller on the AntSeed network.
          </p>
        </header>

        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-card-label">Active peers</div>
            <div className="stat-card-value">{formatNumber(networkPeers)}</div>
            <div className="stat-card-hint">Sellers with on-chain activity</div>
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

        {statsError && (
          <div className="dashboard-stats-error">
            Couldn&apos;t load network stats: {statsError}
          </div>
        )}
      </section>
    </div>
  );
}
