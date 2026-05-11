import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import type { PaymentConfig } from '../types';
import type { ChannelData } from '../lib/api';
import { CHANNELS_ABI } from '../abi';
import { getErrorMessage, usePaymentNetwork } from '../lib/payment-network';
import { useChannels } from '../hooks/use-channels';
import { useAuthorizedWallet } from '../context/authorized-wallet-context';
import { formatCountdownMSS, formatUsd, truncateAddr } from '../lib/format';
import './channels-view.scss';

interface ChannelsViewProps {
  config: PaymentConfig | null;
}

const GRACE_PERIOD = 900; // 15 minutes in seconds
const PAGE_SIZE = 10;

type RowStatus =
  | 'active'
  | 'closing'
  | 'withdrawable'
  | 'settled'
  | 'timedout'
  | 'closed';

function getRowStatus(session: ChannelData): RowStatus {
  if (session.status === 2) return 'settled';
  if (session.status === 3) return 'timedout';
  if (session.status === 0) return 'closed';
  if (session.closeRequestedAt === 0) return 'active';
  const now = Math.floor(Date.now() / 1000);
  if (now < session.closeRequestedAt + GRACE_PERIOD) return 'closing';
  return 'withdrawable';
}

// Status icons matching PR #445 pattern
function ActiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </svg>
  );
}

function ClosingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 7h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function WithdrawableIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2v9M4 8l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SettledIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 7l2 2 3-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TimedOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 4v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="9.5" r="1" fill="currentColor" />
    </svg>
  );
}

function ClosedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={`channels-refresh-icon${spinning ? ' channels-refresh-icon--spin' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 7a5 5 0 1 1-1.46-3.54"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M12 2.25v2.5h-2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STATUS_ICONS: Record<RowStatus, React.ReactNode> = {
  active:       <ActiveIcon />,
  closing:      <ClosingIcon />,
  withdrawable: <WithdrawableIcon />,
  settled:      <SettledIcon />,
  timedout:     <TimedOutIcon />,
  closed:       <ClosedIcon />,
};

const STATUS_META: Record<RowStatus, { label: string; modifier: string }> = {
  active:       { label: 'Active',       modifier: 'status-pill--active' },
  closing:      { label: 'Closing',      modifier: 'status-pill--closing' },
  withdrawable: { label: 'Withdrawable', modifier: 'status-pill--withdrawable' },
  settled:      { label: 'Settled',      modifier: 'status-pill--muted' },
  timedout:     { label: 'Timed out',    modifier: 'status-pill--muted' },
  closed:       { label: 'Closed',       modifier: 'status-pill--muted' },
};

function graceRemaining(closeRequestedAt: number): number {
  return closeRequestedAt + GRACE_PERIOD - Math.floor(Date.now() / 1000);
}

// Accepts either seconds (on-chain style) or milliseconds (Date.now()) — the
// channel store mixes units because `deadline` is a block timestamp (seconds)
// while `reservedAt` is wall-clock ms. Values ≥ 1e12 are treated as ms.
function toMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(toMs(ts)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Table-cell precision: 2 decimals for ≥ $1, 4 decimals for sub-dollar values
// so that micro-payments stay legible without dropping precision to "$0.00".
function formatChannelUsd(value: string): string {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n === 0) return '0.00';
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toFixed(4);
}

function ChannelRow({
  session,
  config,
  onRefresh,
}: {
  session: ChannelData;
  config: PaymentConfig;
  onRefresh: () => void;
}) {
  const status = getRowStatus(session);
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);
  const { requireAuthorization } = useAuthorizedWallet();
  const [error, setError] = useState<string | null>(null);

  const {
    writeContract: writeRequestClose,
    data: closeTxHash,
    reset: resetClose,
    isPending: closeSubmitting,
  } = useWriteContract();
  const { isSuccess: closeConfirmed, isLoading: closeConfirming } = useWaitForTransactionReceipt({
    hash: closeTxHash,
    chainId: expectedChainId,
  });

  const {
    writeContract: writeWithdraw,
    data: withdrawTxHash,
    reset: resetWithdraw,
    isPending: withdrawSubmitting,
  } = useWriteContract();
  const { isSuccess: withdrawConfirmed, isLoading: withdrawConfirming } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
    chainId: expectedChainId,
  });

  const closeBusy = closeSubmitting || closeConfirming;
  const withdrawBusy = withdrawSubmitting || withdrawConfirming;

  const handleRequestClose = useCallback(() => {
    if (closeBusy) return;
    requireAuthorization(async () => {
      setError(null);
      try {
        await ensureCorrectNetwork();
        writeRequestClose({
          address: config.channelsContractAddress as `0x${string}`,
          abi: CHANNELS_ABI,
          functionName: 'requestClose',
          chainId: expectedChainId,
          args: [session.channelId as `0x${string}`],
        }, {
          onError: (err) => setError(getErrorMessage(err)),
        });
      } catch (err) {
        setError(getErrorMessage(err));
      }
    });
  }, [closeBusy, config.channelsContractAddress, ensureCorrectNetwork, expectedChainId, session.channelId, writeRequestClose, requireAuthorization]);

  const handleWithdraw = useCallback(() => {
    if (withdrawBusy) return;
    requireAuthorization(async () => {
      setError(null);
      try {
        await ensureCorrectNetwork();
        writeWithdraw({
          address: config.channelsContractAddress as `0x${string}`,
          abi: CHANNELS_ABI,
          functionName: 'withdraw',
          chainId: expectedChainId,
          args: [session.channelId as `0x${string}`],
        }, {
          onError: (err) => setError(getErrorMessage(err)),
        });
      } catch (err) {
        setError(getErrorMessage(err));
      }
    });
  }, [withdrawBusy, config.channelsContractAddress, ensureCorrectNetwork, expectedChainId, session.channelId, writeWithdraw, requireAuthorization]);

  // After the parent refetches, clear the wagmi receipt state so the row drops
  // out of the "confirmed → Refresh" branch and renders the action button that
  // matches the new on-chain status.
  const handleRefreshRow = useCallback(() => {
    resetClose();
    resetWithdraw();
    setError(null);
    onRefresh();
  }, [resetClose, resetWithdraw, onRefresh]);

  const meta = STATUS_META[status];
  const pillLabel = status === 'closing'
    ? `Closing ${formatCountdownMSS(graceRemaining(session.closeRequestedAt))}`
    : meta.label;

  return (
    <tr>
      <td className="channels-table-cell-seller" title={session.seller}>
        {truncateAddr(session.seller)}
      </td>
      <td className="channels-table-cell-id" title={session.channelId}>
        {session.channelId.slice(0, 10)}…
      </td>
      <td>
        <span className={`status-pill ${meta.modifier}`}>
          <span className="status-pill-icon">{STATUS_ICONS[status]}</span>
          {pillLabel}
        </span>
      </td>
      <td className="channels-table-num">${formatChannelUsd(session.deposit)}</td>
      <td className="channels-table-num">${formatChannelUsd(session.settled)}</td>
      <td className="channels-table-date" title={formatDate(session.reservedAt)}>
        {formatDate(session.reservedAt)}
      </td>
      <td className="channels-table-action">
        {closeConfirmed || withdrawConfirmed ? (
          <button className="btn-link" onClick={handleRefreshRow}>Refresh</button>
        ) : status === 'active' ? (
          <button
            className="btn-outline"
            onClick={handleRequestClose}
            disabled={closeBusy}
          >
            {closeSubmitting ? 'Confirm…' : closeConfirming ? 'Closing…' : 'Close'}
          </button>
        ) : status === 'closing' ? (
          <button className="btn-outline" disabled>Waiting…</button>
        ) : status === 'withdrawable' ? (
          <button
            className="btn-primary"
            onClick={handleWithdraw}
            disabled={withdrawBusy}
          >
            {withdrawSubmitting ? 'Confirm…' : withdrawConfirming ? 'Withdrawing…' : 'Withdraw'}
          </button>
        ) : (
          <span className="channels-table-dash">—</span>
        )}
        {error && <div className="channels-table-error">{error}</div>}
      </td>
    </tr>
  );
}

export function ChannelsView({ config }: ChannelsViewProps) {
  const { channels, history, loading, refetch } = useChannels(config);
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Spin for ≥500ms even when refetch resolves instantly — the local API
  // usually returns the same data, so without this the click feels inert.
  const fetchData = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await refetch();
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 500) {
        await new Promise((resolve) => setTimeout(resolve, 500 - elapsed));
      }
      setRefreshing(false);
    }
  }, [refetch]);

  // Active first, then history — keeps actionable rows on page one.
  const allChannels = useMemo(() => [...channels, ...history], [channels, history]);

  const totals = useMemo(() => {
    const reserved = channels.reduce((a, c) => a + (parseFloat(c.deposit) || 0), 0);
    const used = channels.reduce((a, c) => a + (parseFloat(c.settled) || 0), 0);
    const totalSpent = allChannels.reduce((a, c) => a + (parseFloat(c.settled) || 0), 0);
    return {
      active: channels.length,
      reserved,
      used,
      total: allChannels.length,
      totalSpent,
    };
  }, [channels, allChannels]);

  const pageCount = Math.max(1, Math.ceil(allChannels.length / PAGE_SIZE));
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const pageRows = useMemo(
    () => allChannels.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [allChannels, page],
  );

  const initialLoading = loading && allChannels.length === 0;

  return (
    <div className="channels-view overview-view">
      <section className="overview-section">
        <div className="channels-section-head-row">
          <header className="overview-section-head">
            <div className="overview-section-eyebrow">Your channels</div>
            <h2 className="overview-section-title">Payment channels</h2>
            <p className="overview-section-sub">
              Payment channels between you and sellers. Reserve funds once, then settle
              per-request against the escrow.
            </p>
          </header>
          <button
            type="button"
            className="btn-outline channels-refresh-btn"
            onClick={fetchData}
            disabled={refreshing || initialLoading}
            aria-label="Refresh channels"
          >
            <RefreshIcon spinning={refreshing} />
            <span>{refreshing ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>

        <div className="overview-chart-card">
          <div className="overview-kpi-row" aria-busy={initialLoading || undefined}>
            <div className="overview-kpi">
              <div className="overview-kpi-label">Active</div>
              {initialLoading ? (
                <span className="skel skel-block skel-block--value" />
              ) : (
                <div className="overview-kpi-value">{totals.active} / {totals.total}</div>
              )}
            </div>
            <div className="overview-kpi">
              <div className="overview-kpi-label">Reserved</div>
              {initialLoading ? (
                <span className="skel skel-block skel-block--value" />
              ) : (
                <div className="overview-kpi-value">${formatUsd(totals.reserved)}</div>
              )}
            </div>
            <div className="overview-kpi">
              <div className="overview-kpi-label">Used</div>
              {initialLoading ? (
                <span className="skel skel-block skel-block--value" />
              ) : (
                <div className="overview-kpi-value">${formatUsd(totals.used)}</div>
              )}
            </div>
            <div className="overview-kpi">
              <div className="overview-kpi-label">Total Spent</div>
              {initialLoading ? (
                <span className="skel skel-block skel-block--value" />
              ) : (
                <div className="overview-kpi-value">${formatUsd(totals.totalSpent)}</div>
              )}
            </div>
          </div>

          {initialLoading ? (
            <ChannelsTableSkeleton />
          ) : allChannels.length === 0 ? (
            <div className="channels-view-empty">No channels yet</div>
          ) : (
            <>
              <div className="channels-table-wrap">
                <table className="channels-table">
                  <thead>
                    <tr>
                      <th>Seller</th>
                      <th>Channel</th>
                      <th>Status</th>
                      <th className="channels-table-num">Reserved</th>
                      <th className="channels-table-num">Used</th>
                      <th>Opened</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((session) => (
                      config ? (
                        <ChannelRow
                          key={session.channelId}
                          session={session}
                          config={config}
                          onRefresh={fetchData}
                        />
                      ) : null
                    ))}
                  </tbody>
                </table>
              </div>

              {pageCount > 1 && (
                <div className="channels-pagination">
                  <button
                    type="button"
                    className="channels-pagination-btn"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    aria-label="Previous page"
                  >
                    <span aria-hidden="true">←</span>
                    <span>Prev</span>
                  </button>
                  <span className="channels-pagination-info">
                    Page <strong>{page + 1}</strong> of {pageCount}
                  </span>
                  <button
                    type="button"
                    className="channels-pagination-btn"
                    disabled={page >= pageCount - 1}
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    aria-label="Next page"
                  >
                    <span>Next</span>
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function ChannelsTableSkeleton() {
  return (
    <div className="channels-table-wrap" aria-busy="true" aria-label="Loading channels">
      <table className="channels-table">
        <thead>
          <tr>
            <th>Seller</th>
            <th>Channel</th>
            <th>Status</th>
            <th className="channels-table-num">Reserved</th>
            <th className="channels-table-num">Used</th>
            <th>Opened</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 4 }).map((_, i) => (
            <tr key={i}>
              <td><span className="skel skel-line skel-line--cell" style={{ width: 80 }} /></td>
              <td><span className="skel skel-line skel-line--cell" style={{ width: 84 }} /></td>
              <td><span className="skel skel-pill" /></td>
              <td className="channels-table-num">
                <span className="skel skel-line skel-line--cell" style={{ width: 56, marginLeft: 'auto' }} />
              </td>
              <td className="channels-table-num">
                <span className="skel skel-line skel-line--cell" style={{ width: 56, marginLeft: 'auto' }} />
              </td>
              <td><span className="skel skel-line skel-line--cell" style={{ width: 90 }} /></td>
              <td><span className="skel skel-line skel-line--cell" style={{ width: 16 }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

