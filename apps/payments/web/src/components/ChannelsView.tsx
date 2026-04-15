import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { getOperatorInfo, type ChannelData } from '../api';
import { CHANNELS_ABI } from '../channels-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { useSetOperator } from '../hooks/useSetOperator';
import { useChannels } from '../hooks/useChannels';
import '../views/DashboardView.scss';
import './ChannelsView.scss';

interface ChannelsViewProps {
  config: PaymentConfig | null;
}

const GRACE_PERIOD = 900; // 15 minutes in seconds
const PAGE_SIZE = 10;

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

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

const STATUS_META: Record<RowStatus, { label: string; modifier: string }> = {
  active:       { label: 'Active',       modifier: 'status-pill--active' },
  closing:      { label: 'Closing',      modifier: 'status-pill--closing' },
  withdrawable: { label: 'Withdrawable', modifier: 'status-pill--withdrawable' },
  settled:      { label: 'Settled',      modifier: 'status-pill--muted' },
  timedout:     { label: 'Timed out',    modifier: 'status-pill--muted' },
  closed:       { label: 'Closed',       modifier: 'status-pill--muted' },
};

function formatTimeRemaining(closeRequestedAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const remaining = closeRequestedAt + GRACE_PERIOD - now;
  if (remaining <= 0) return '0:00';
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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

const parsedAbi = parseAbi(CHANNELS_ABI);

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
  const [error, setError] = useState<string | null>(null);

  const { writeContract: writeRequestClose, data: closeTxHash } = useWriteContract();
  const { isSuccess: closeConfirmed } = useWaitForTransactionReceipt({
    hash: closeTxHash,
    chainId: expectedChainId,
  });

  const { writeContract: writeWithdraw, data: withdrawTxHash } = useWriteContract();
  const { isSuccess: withdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
    chainId: expectedChainId,
  });

  const handleRequestClose = useCallback(async () => {
    setError(null);
    try {
      await ensureCorrectNetwork();
      writeRequestClose({
        address: config.channelsContractAddress as `0x${string}`,
        abi: parsedAbi,
        functionName: 'requestClose',
        chainId: expectedChainId,
        args: [session.channelId as `0x${string}`],
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [config.channelsContractAddress, ensureCorrectNetwork, expectedChainId, session.channelId, writeRequestClose]);

  const handleWithdraw = useCallback(async () => {
    setError(null);
    try {
      await ensureCorrectNetwork();
      writeWithdraw({
        address: config.channelsContractAddress as `0x${string}`,
        abi: parsedAbi,
        functionName: 'withdraw',
        chainId: expectedChainId,
        args: [session.channelId as `0x${string}`],
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [config.channelsContractAddress, ensureCorrectNetwork, expectedChainId, session.channelId, writeWithdraw]);

  const meta = STATUS_META[status];
  const pillLabel = status === 'closing'
    ? `Closing ${formatTimeRemaining(session.closeRequestedAt)}`
    : meta.label;

  return (
    <tr>
      <td className="channels-table-cell-seller" title={session.seller}>
        {truncateAddress(session.seller)}
      </td>
      <td className="channels-table-cell-id" title={session.channelId}>
        {session.channelId.slice(0, 10)}…
      </td>
      <td>
        <span className={`status-pill ${meta.modifier}`}>{pillLabel}</span>
      </td>
      <td className="channels-table-num">${session.deposit}</td>
      <td className="channels-table-num">${session.settled}</td>
      <td className="channels-table-date" title={formatDate(session.reservedAt)}>
        {formatDate(session.reservedAt)}
      </td>
      <td className="channels-table-action">
        {closeConfirmed || withdrawConfirmed ? (
          <button className="btn-link" onClick={onRefresh}>Refresh</button>
        ) : status === 'active' ? (
          <button className="btn-outline" onClick={handleRequestClose}>Close</button>
        ) : status === 'closing' ? (
          <button className="btn-outline" disabled>Waiting…</button>
        ) : status === 'withdrawable' ? (
          <button className="btn-primary" onClick={handleWithdraw}>Withdraw</button>
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
  const [operatorSet, setOperatorSet] = useState<boolean | null>(null);
  const [page, setPage] = useState(0);

  const fetchOperator = useCallback(async () => {
    const operatorResult = await getOperatorInfo().catch(() => null);
    if (operatorResult) {
      setOperatorSet(operatorResult.operator !== '0x0000000000000000000000000000000000000000');
    }
  }, []);

  useEffect(() => { void fetchOperator(); }, [fetchOperator]);

  const fetchData = useCallback(async () => {
    await Promise.all([refetch(), fetchOperator()]);
  }, [refetch, fetchOperator]);

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

  return (
    <div className="channels-view dashboard-view">
      {operatorSet === false && <SetOperatorBanner config={config} onSet={fetchData} />}

      <section className="dashboard-section">
        <div className="channels-section-head-row">
          <header className="dashboard-section-head">
            <div className="dashboard-section-eyebrow">Your channels</div>
            <h2 className="dashboard-section-title">Payment channels</h2>
            <p className="dashboard-section-sub">
              Payment channels between you and sellers. Reserve funds once, then settle
              per-request against the escrow.
            </p>
          </header>
          <button className="btn-outline channels-refresh-btn" onClick={fetchData}>
            Refresh
          </button>
        </div>

        <div className="dashboard-chart-card">
          <div className="dashboard-kpi-row">
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Active</div>
              <div className="dashboard-kpi-value">{totals.active} / {totals.total}</div>
            </div>
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Reserved</div>
              <div className="dashboard-kpi-value">${totals.reserved.toFixed(2)}</div>
            </div>
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Used</div>
              <div className="dashboard-kpi-value">${totals.used.toFixed(2)}</div>
            </div>
            <div className="dashboard-kpi">
              <div className="dashboard-kpi-label">Total Spent</div>
              <div className="dashboard-kpi-value">${totals.totalSpent.toFixed(2)}</div>
            </div>
          </div>

          {/* <div className="channels-table-caption">
            {allChannels.length} channel{allChannels.length === 1 ? '' : 's'}
            {channels.length > 0 && ` · ${channels.length} active`}
          </div> */}

          {loading && allChannels.length === 0 ? (
            <div className="channels-view-empty">Loading channels…</div>
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

/* ── Set Operator Banner ── */

function SetOperatorBanner({ config, onSet }: { config: PaymentConfig | null; onSet: () => void }) {
  const { address } = useAccount();
  const { run, running, error } = useSetOperator(config, onSet);

  return (
    <div className="status-msg" style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
        No wallet set. This is the wallet used to claim ANTS rewards and manage channels. Set your connected wallet to continue.
      </div>
      <button
        className="btn-outline"
        style={{ fontSize: 12, padding: '4px 12px' }}
        onClick={run}
        disabled={running || !address}
      >
        {running ? 'Setting wallet...' : 'Set Your Wallet'}
      </button>
      {error && <div style={{ color: 'var(--error)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}
