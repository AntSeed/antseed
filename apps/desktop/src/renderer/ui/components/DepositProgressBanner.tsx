import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, ArrowUpRight01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useUiSelector } from '../hooks/useUiSelector';
import { useActions } from '../hooks/useActions';
import type { DepositWatchStatus } from '../../types/bridge';
import styles from './DepositProgressBanner.module.scss';

const CREDITED_AUTO_HIDE_MS = 10_000;

function baseUnitsToUsd(baseUnits: string | undefined): string {
  if (!baseUnits) return '0';
  const value = Number(baseUnits) / 1e6;
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function explorerTxUrl(txHash: string): string {
  return `https://basescan.org/tx/${txHash}`;
}

/**
 * App-wide deposit progress notification — same bottom-bar presentation as
 * UpdateBanner. The main-process deposit watcher keeps running (at a slower
 * cadence) after the deposit view closes, so a card/Fun delivery landing
 * minutes later is still swept; this banner is how that progress stays
 * visible from any view.
 */
export function DepositProgressBanner() {
  const networkAlert = useUiSelector((state) => state.networkAlert);
  const actions = useActions();
  const [status, setStatus] = useState<DepositWatchStatus | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const bridge = window.antseedDesktop;
    if (!bridge?.onDepositsWatchStatus) return undefined;
    const unsubscribe = bridge.onDepositsWatchStatus((data) => {
      setStatus(data);
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      if (data.phase === 'credited') {
        actions.refreshCredits();
        hideTimer.current = window.setTimeout(() => setStatus(null), CREDITED_AUTO_HIDE_MS);
      }
    });
    return () => {
      unsubscribe();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [actions]);

  // The network alert owns the slot.
  if (networkAlert !== 'none' || !status) return null;

  const { phase } = status;
  const amount = baseUnitsToUsd(status.amountBaseUnits);

  const title = phase === 'received'
    ? `Received $${amount}`
    : phase === 'sweeping'
      ? `Depositing $${amount} to your credits…`
      : phase === 'credited'
        ? `$${amount} added to your balance`
        : 'Deposit needs attention';

  // Portaled to <body>: the banner must escape the app's stacking contexts to
  // paint above overlays — most importantly the Fun checkout modal, which
  // sits at z-index 2147483646 while a deposit is in flight.
  return createPortal(
    <div
      className={`${styles.banner}${phase === 'error' ? ` ${styles.bannerError}` : ''}`}
      role={phase === 'error' ? 'alert' : 'status'}
    >
      <span className={styles.icon} aria-hidden="true">
        {phase === 'credited' ? (
          <HugeiconsIcon icon={Tick02Icon} size={18} strokeWidth={2.5} />
        ) : phase === 'error' ? (
          <HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.8} className={styles.iconError} />
        ) : (
          <span
            className={styles.pulse}
            style={{ background: phase === 'sweeping' ? 'var(--accent-green)' : '#f59e0b' }}
          />
        )}
      </span>
      <div className={styles.text}>
        <span className={`${styles.title}${phase === 'error' ? ` ${styles.titleError}` : ''}`}>{title}</span>
        {phase === 'received' && <span className={styles.body}>Preparing the deposit…</span>}
        {phase === 'error' && status.error && <span className={styles.body}>{status.error}</span>}
      </div>
      {phase === 'credited' && status.txHash && (
        <button
          type="button"
          className={styles.action}
          onClick={() => void window.antseedDesktop?.openExternalUrl?.(explorerTxUrl(status.txHash!))}
        >
          <span>View transaction</span>
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={2} />
        </button>
      )}
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss deposit status"
        onClick={() => setStatus(null)}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
