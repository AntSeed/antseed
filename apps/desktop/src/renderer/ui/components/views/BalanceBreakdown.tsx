import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, HelpCircleIcon } from '@hugeicons/core-free-icons';
import { formatCredits } from '../../../core/format';
import { InfoTooltip } from '../InfoTooltip';
import {
  hasPositiveAmount,
  isEntireBalanceLocked,
  walletBalanceMessage,
  type BalanceBreakdownValues,
} from './balance-breakdown';
import styles from './BalanceBreakdown.module.scss';

export function BalanceWarning({ values }: { values: BalanceBreakdownValues }): JSX.Element | null {
  if (!isEntireBalanceLocked(values)) return null;
  return (
    <InfoTooltip
      align="left"
      content={(
        <>
          <strong>Your available balance is locked</strong>
          <span>${formatCredits(values.reserved)} is held in open payment channels, leaving no balance available to start another paid session or withdraw. Funds become available again when those channels close.</span>
        </>
      )}
    >
      <button type="button" className={styles.warningButton} aria-label="Some balance is held in open sessions">
        <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={2} />
      </button>
    </InfoTooltip>
  );
}

export function BalanceBreakdown({ values, compact = false }: {
  values: BalanceBreakdownValues;
  compact?: boolean;
}): JSX.Element {
  const walletMessage = walletBalanceMessage(values);
  return (
    <div className={`${styles.breakdown}${compact ? ` ${styles.compact}` : ''}`}>
      {hasPositiveAmount(values.available) ? (
        <div className={styles.row}>
          <span>Ready to use</span><span>${formatCredits(values.available)}</span>
        </div>
      ) : null}
      {hasPositiveAmount(values.reserved) ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>
            Held in open sessions
            <BalanceWarning values={values} />
          </span>
          <span>${formatCredits(values.reserved)}</span>
        </div>
      ) : null}
      {hasPositiveAmount(values.pending) ? (
        <div className={styles.row}>
          <span>Authorized, not yet charged</span>
          <span>-${formatCredits(values.pending)}</span>
        </div>
      ) : null}
      {hasPositiveAmount(values.wallet) ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>
            In deposit wallet
            <InfoTooltip align="left" content={<span>{walletMessage}</span>}>
              <button type="button" className={styles.infoButton} aria-label="About deposit wallet balance">i</button>
            </InfoTooltip>
          </span>
          <span>${formatCredits(values.wallet)}</span>
        </div>
      ) : null}
      <div className={`${styles.row} ${styles.totalRow}`}>
        <span>Total balance</span><span>${formatCredits(values.totalOwned)}</span>
      </div>
      {hasPositiveAmount(values.wallet) ? <p className={styles.walletNote}>{walletMessage}</p> : null}
    </div>
  );
}

export function BalanceInfoPopover({ values }: { values: BalanceBreakdownValues }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const panelId = useId();

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimer.current === null) return;
    window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  }, []);

  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => {
      setOpen(false);
      hoverCloseTimer.current = null;
    }, 120);
  }, [cancelHoverClose]);

  const reposition = useCallback(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!button || !panel) return;

    const viewportMargin = 12;
    const gap = 8;
    const buttonRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - viewportMargin * 2);
    const height = Math.min(panelRect.height, window.innerHeight - viewportMargin * 2);
    const left = Math.min(
      Math.max(viewportMargin, buttonRect.right - width),
      window.innerWidth - width - viewportMargin,
    );
    const belowTop = buttonRect.bottom + gap;
    const aboveTop = buttonRect.top - height - gap;
    const fitsBelow = belowTop + height <= window.innerHeight - viewportMargin;
    const top = fitsBelow || aboveTop < viewportMargin
      ? Math.min(belowTop, window.innerHeight - height - viewportMargin)
      : aboveTop;

    setPanelStyle({ left, top: Math.max(viewportMargin, top), width, visibility: 'visible' });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => () => cancelHoverClose(), [cancelHoverClose]);

  const closeWhenFocusLeaves = () => {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && !rootRef.current?.contains(active) && !panelRef.current?.contains(active)) setOpen(false);
    }, 0);
  };

  return (
    <div
      ref={rootRef}
      className={styles.popoverRoot}
      onBlur={closeWhenFocusLeaves}
      onMouseEnter={() => {
        cancelHoverClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleHoverClose}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.popoverButton}
        aria-label="Show balance details"
        aria-expanded={open}
        aria-controls={panelId}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen((current) => !current)}
      >
        <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={2} />
      </button>
      {open ? createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className={styles.popoverPanel}
          style={panelStyle}
          role="dialog"
          aria-label="Balance details"
          onBlur={closeWhenFocusLeaves}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          <strong className={styles.popoverTitle}>Where your balance is</strong>
          <BalanceBreakdown values={values} compact />
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
