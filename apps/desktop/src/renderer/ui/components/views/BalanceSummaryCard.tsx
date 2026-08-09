import { useContext, type ReactNode } from 'react';
import { formatCredits } from '../../../core/format';
import { VprCard } from '../vpr/VprKit';
import { VprNavContext } from '../vpr/VprNavContext';
import { BalanceInfoPopover, BalanceWarning } from './BalanceBreakdown';
import type { BalanceBreakdownValues } from './balance-breakdown';
import styles from './BalanceSummaryCard.module.scss';

export function BalanceSummaryCard({ values, actions }: {
  values: BalanceBreakdownValues;
  actions?: ReactNode;
}): JSX.Element {
  const nav = useContext(VprNavContext);
  return (
    <VprCard className={styles.card}>
      <span className={styles.labelRow}>
        <span className={styles.label}>Your balance</span>
        <BalanceInfoPopover values={values} onManageOpenSessions={() => nav?.navigate('activity')} />
      </span>
      <span className={styles.valueRow}>
        <span className={styles.value}>${formatCredits(values.totalOwned)}</span>
        <BalanceWarning values={values} />
      </span>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </VprCard>
  );
}
