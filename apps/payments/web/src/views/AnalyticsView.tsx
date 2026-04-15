import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PaymentConfig } from '../types';
import {
  getBuyerStats,
  type BuyerStatsResponse,
  type BuyerStatsSellerRow,
} from '../api';
import { useChannels } from '../hooks/useChannels';

interface AnalyticsViewProps {
  config: PaymentConfig | null;
}

type SortKey = 'totalRequests' | 'settlementCount' | 'totalInputTokens' | 'totalOutputTokens';

function truncateAddress(addr: string | null): string {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatNumber(n: string | number): string {
  const num = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString();
}

function formatBigintTokens(s: string): string {
  try {
    return BigInt(s).toLocaleString();
  } catch {
    return '0';
  }
}

function formatDollars(s: string | undefined): string {
  if (!s) return '$0.00';
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

export function AnalyticsView({ config }: AnalyticsViewProps) {
  const [stats, setStats] = useState<BuyerStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('totalRequests');

  const buyerAddress = config?.evmAddress ?? null;
  const networkStatsUrl = config?.networkStatsUrl ?? null;

  const { channels: activeChannels } = useChannels(config);

  const load = useCallback(async () => {
    if (!buyerAddress) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    if (!networkStatsUrl) {
      setStats(null);
      setError('Network stats not configured for this chain');
      setLoading(false);
      return;
    }

    try {
      const statsRes = await getBuyerStats(networkStatsUrl, buyerAddress);
      setStats(statsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [buyerAddress, networkStatsUrl]);

  useEffect(() => { void load(); }, [load]);

  const sortedBySeller = useMemo<BuyerStatsSellerRow[]>(() => {
    if (!stats?.bySeller) return [];
    const arr = [...stats.bySeller];
    arr.sort((a, b) => {
      if (sortKey === 'settlementCount') return b.settlementCount - a.settlementCount;
      const av = BigInt(a[sortKey]);
      const bv = BigInt(b[sortKey]);
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
    return arr;
  }, [stats?.bySeller, sortKey]);

  // Live channel strip — sum deposit/settled across currently-active channels.
  const liveChannels = useMemo(() => {
    const count = activeChannels.length;
    const locked  = activeChannels.reduce((a, c) => a + parseFloat(c.deposit), 0);
    const settled = activeChannels.reduce((a, c) => a + parseFloat(c.settled), 0);
    return { count, locked, settled };
  }, [activeChannels]);

  if (loading && !stats) {
    return (
      <div className="card">
        <div className="card-section-title">Analytics</div>
        <div className="overview-empty">
          <div className="overview-empty-desc">Loading…</div>
        </div>
      </div>
    );
  }

  const emptyState = !stats?.totals && !error;

  return (
    <div className="analytics-view">
      {/* Top-line cards */}
      <div className="analytics-topline">
        <TopCard label="Settlements" value={formatNumber(stats?.totals?.totalSettlements ?? 0)} />
        <TopCard label="Requests"    value={formatNumber(stats?.totals?.totalRequests ?? '0')} />
        <TopCard label="Tokens (in+out)" value={
          stats?.totals
            ? formatBigintTokens((BigInt(stats.totals.totalInputTokens) + BigInt(stats.totals.totalOutputTokens)).toString())
            : '0'
        } />
        <TopCard label="Unique Sellers" value={formatNumber(stats?.totals?.uniqueSellers ?? 0)} />
      </div>

      {/* Live channel strip */}
      <div className="card analytics-live-strip">
        <div className="card-section-title">Live Channels</div>
        <div className="analytics-live-grid">
          <div>
            <div className="analytics-live-label">Active</div>
            <div className="analytics-live-value">{liveChannels.count}</div>
          </div>
          <div>
            <div className="analytics-live-label">Locked USDC</div>
            <div className="analytics-live-value">${liveChannels.locked.toFixed(2)}</div>
          </div>
          <div>
            <div className="analytics-live-label">Settled USDC</div>
            <div className="analytics-live-value">${liveChannels.settled.toFixed(2)}</div>
          </div>
        </div>
      </div>

      {/* Sync indicator / error / empty / per-seller */}
      {error && (
        <div className="card analytics-error">
          <div className="card-section-title">Analytics unavailable</div>
          <div className="overview-empty-desc">{error}</div>
          <button className="btn-outline" onClick={() => void load()} style={{ marginTop: 12, fontSize: 12 }}>
            Retry
          </button>
        </div>
      )}

      {emptyState && (
        <div className="card">
          <div className="card-section-title">Analytics</div>
          <div className="overview-empty">
            <div className="overview-empty-title">No activity yet</div>
            <div className="overview-empty-desc">
              Analytics populates as you settle channels on-chain. Start a chat
              from the desktop app to accrue your first data points.
            </div>
          </div>
        </div>
      )}

      {stats?.indexer && (
        <div className="analytics-sync">
          Indexed to block #{stats.indexer.lastBlock}
          {stats.indexer.synced === false && <span className="analytics-sync-badge">Syncing…</span>}
        </div>
      )}

      {!error && stats?.bySeller && stats.bySeller.length > 0 && (
        <div className="card">
          <div className="card-section-title">Per-seller breakdown</div>
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Seller</th>
                <SortHeader label="Settlements" k="settlementCount" active={sortKey} onClick={setSortKey} />
                <SortHeader label="Requests"    k="totalRequests"   active={sortKey} onClick={setSortKey} />
                <SortHeader label="Input tok"   k="totalInputTokens"  active={sortKey} onClick={setSortKey} />
                <SortHeader label="Output tok"  k="totalOutputTokens" active={sortKey} onClick={setSortKey} />
                <th>First block</th>
                <th>Last block</th>
              </tr>
            </thead>
            <tbody>
              {sortedBySeller.map((r) => (
                <tr key={r.agentId}>
                  <td title={r.publicAddress ?? undefined}>{truncateAddress(r.publicAddress)}</td>
                  <td>{formatNumber(r.settlementCount)}</td>
                  <td>{formatBigintTokens(r.totalRequests)}</td>
                  <td>{formatBigintTokens(r.totalInputTokens)}</td>
                  <td>{formatBigintTokens(r.totalOutputTokens)}</td>
                  <td>{r.firstBlock}</td>
                  <td>{r.lastBlock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TopCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card analytics-top-card">
      <div className="analytics-top-label">{label}</div>
      <div className="analytics-top-value">{value}</div>
    </div>
  );
}

function SortHeader({ label, k, active, onClick }: {
  label: string;
  k: SortKey;
  active: SortKey;
  onClick: (k: SortKey) => void;
}) {
  return (
    <th
      className={`analytics-sort${active === k ? ' analytics-sort--active' : ''}`}
      onClick={() => onClick(k)}
    >
      {label}{active === k ? ' ↓' : ''}
    </th>
  );
}
