import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { shortAddress } from '../../../core/format';
import { VprCard, VprPage, VprStatRow, VprStatTile } from '../vpr/VprKit';
import {
  channelCloseAction,
  requestSellerAssistedClose,
  type ChannelCloseFeedback,
} from './vpr-activity-close';
import styles from './VprActivityView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

function baseUnitsToUsd(value: string | undefined): string {
  try {
    const units = BigInt(value ?? '0');
    const whole = units / 1_000_000n;
    const cents = (units % 1_000_000n) / 10_000n;
    return `${whole}.${cents.toString().padStart(2, '0')}`;
  } catch {
    return '0.00';
  }
}

function sumBaseUnits(values: Array<string | undefined>): string {
  let total = 0n;
  for (const value of values) {
    try {
      total += BigInt(value ?? '0');
    } catch {
      // skip malformed row
    }
  }
  return total.toString();
}

function isActiveStatus(status: string): boolean {
  return status === 'active' || status === 'open';
}

/** Signed but not yet settled on this channel, in base units. */
function unsettledBaseUnits(row: { cumulativeSigned: string; settledUsdc: string }): bigint {
  try {
    const signed = BigInt(row.cumulativeSigned || '0');
    const settled = BigInt(row.settledUsdc || '0');
    return signed > settled ? signed - settled : 0n;
  } catch {
    return 0n;
  }
}

function statusTone(status: string): 'active' | 'pending' | 'closed' {
  if (isActiveStatus(status) || status === 'withdrawable') return 'active';
  if (status === 'closing' || status === 'close_requested' || status === 'pending') return 'pending';
  return 'closed';
}

function formatDate(tsSeconds: number): string {
  if (!tsSeconds) return '';
  // reservedAt may arrive in seconds or milliseconds depending on source.
  const ms = tsSeconds > 1_000_000_000_000 ? tsSeconds : tsSeconds * 1000;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

/** In-app payment-channel activity and channel-close actions. */
export function VprActivityView({ onSelectView }: Props) {
  const actions = useActions();
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null);
  const [closeFeedback, setCloseFeedback] = useState<Record<string, ChannelCloseFeedback>>({});
  const snap = useUiSelector((state) => ({
    channels: state.creditsChannels,
    loading: state.creditsSummaryLoading,
  }), shallowEqual);

  // Force-refresh on entry and whenever the window regains focus — the user
  // typically lands here right after an on-chain action in the browser pay
  // popup, so the 55s summary throttle would otherwise serve stale data.
  useEffect(() => {
    actions.refreshPaymentSummary(true);
    const timer = window.setInterval(() => actions.refreshPaymentSummary(), PAYMENT_SUMMARY_POLL_MS);
    const onFocus = () => actions.refreshPaymentSummary(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [actions]);

  const rows = useMemo(
    () => [...snap.channels].sort((a, b) => (b.reservedAt || 0) - (a.reservedAt || 0)),
    [snap.channels],
  );
  const activeCount = rows.filter((row) => isActiveStatus(row.status)).length;
  const totalSpent = sumBaseUnits(rows.map((row) => row.cumulativeSigned));
  // Authorized on channels the seller can still settle against — already
  // committed, so it is deducted from the headline balance elsewhere.
  const totalPending = rows
    .filter((row) => isActiveStatus(row.status) || row.status === 'closing' || row.status === 'withdrawable')
    .reduce((sum, row) => sum + unsettledBaseUnits(row), 0n)
    .toString();

  const openOnChainClose = (channelId: string) => {
    void window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'close-channel', channelId });
  };

  const askSellerToClose = async (channelId: string, peerId: string) => {
    setPendingChannelId(channelId);
    setCloseFeedback((current) => {
      const next = { ...current };
      delete next[channelId];
      return next;
    });
    const feedback = await requestSellerAssistedClose(peerId, window.antseedDesktop, {
      credits: () => actions.refreshCredits(),
      summary: () => actions.refreshPaymentSummary(true),
    });
    setCloseFeedback((current) => ({ ...current, [channelId]: feedback }));
    setPendingChannelId(null);
  };

  return (
    <section className={`view view-vpr-activity view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Activity" backFallback="credits">
      <div className={styles.stack}>

        <VprStatRow>
          <VprStatTile label="Active" value={activeCount} />
          <VprStatTile label="Pending" value={`$${baseUnitsToUsd(totalPending)}`} />
          <VprStatTile label="Spent" value={`$${baseUnitsToUsd(totalSpent)}`} />
        </VprStatRow>

        {rows.length === 0 ? (
          <VprCard className={styles.emptyCard}>
            <span className={styles.emptyTitle}>{snap.loading ? 'Loading activity...' : 'No payment activity yet'}</span>
            <span className={styles.emptyHint}>
              Channels open automatically when you start using the network and settle as you go.
            </span>
          </VprCard>
        ) : (
          <VprCard className={styles.listCard}>
            {rows.map((row) => {
              const closeAction = channelCloseAction(row.status, row.cooperativeCloseSupported);
              const pending = pendingChannelId === row.channelId;
              const feedback = closeFeedback[row.channelId];
              return (
                <div key={row.channelId} className={styles.row}>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>
                      <span className={styles.rowSeller}>{shortAddress(row.seller || row.peerId || null)}</span>
                      <span className={`${styles.statusPill} ${styles[`status_${statusTone(row.status)}`]}`}>
                        {row.status}
                      </span>
                    </div>
                    <span className={styles.rowMeta}>
                      {formatDate(row.reservedAt)}
                      {row.requestCount ? ` · ${row.requestCount.toLocaleString('en-US')} requests` : ''}
                    </span>
                    {feedback && (
                      <span className={`${styles.closeFeedback} ${styles[`closeFeedback_${feedback.tone}`]}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
                        {feedback.message}
                      </span>
                    )}
                  </div>
                  <div className={styles.rowSide}>
                    <span className={styles.rowAmount}>${baseUnitsToUsd(row.cumulativeSigned)}</span>
                    <span className={styles.rowReserve}>
                      {unsettledBaseUnits(row) > 0n
                        ? `$${baseUnitsToUsd(unsettledBaseUnits(row).toString())} pending`
                        : `of $${baseUnitsToUsd(row.reserveMax)}`}
                    </span>
                    {closeAction === 'seller-and-on-chain' && (
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.rowAction}
                          disabled={pending}
                          onClick={() => { void askSellerToClose(row.channelId, row.peerId); }}
                        >
                          {pending ? 'Asking seller…' : 'Ask seller to close'}
                        </button>
                        <button
                          type="button"
                          className={styles.rowActionSecondary}
                          disabled={pending}
                          onClick={() => openOnChainClose(row.channelId)}
                        >
                          <span>Request on-chain close</span>
                          <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                        </button>
                      </div>
                    )}
                    {closeAction === 'on-chain' && (
                      <button type="button" className={styles.rowActionSecondary} onClick={() => openOnChainClose(row.channelId)}>
                        <span>Request on-chain close</span>
                        <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                      </button>
                    )}
                    {closeAction === 'withdraw' && (
                      <button type="button" className={styles.rowAction} onClick={() => openOnChainClose(row.channelId)}>
                        <span>Withdraw</span>
                        <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </VprCard>
        )}

        <span className={styles.footnote}>
          Seller-assisted close is immediate when supported. On-chain close requires a wallet
          transaction and a 15-minute wait before withdrawal.
        </span>
      </div>
      </VprPage>
    </section>
  );
}
