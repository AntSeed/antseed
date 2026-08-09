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

export function BalanceBreakdown({ values, compact = false, onManageOpenSessions }: {
  values: BalanceBreakdownValues;
  compact?: boolean;
  onManageOpenSessions?: () => void;
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
            {onManageOpenSessions ? (
              <button
                type="button"
                className={styles.manageButton}
                aria-label="Manage open sessions"
                onClick={onManageOpenSessions}
              >
                (Manage)
              </button>
            ) : null}
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

export function BalanceInfoPopover({ values, onManageOpenSessions }: {
  values: BalanceBreakdownValues;
  onManageOpenSessions?: () => void;
}): JSX.Element {
  return (
    <InfoTooltip
      align="left"
      wide
      interactive
      content={(
        <>
          <strong>Where your balance is</strong>
          <BalanceBreakdown values={values} compact onManageOpenSessions={onManageOpenSessions} />
        </>
      )}
    >
      <button
        type="button"
        className={styles.popoverButton}
        aria-label="Show balance details"
      >
        <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={2} />
      </button>
    </InfoTooltip>
  );
}
