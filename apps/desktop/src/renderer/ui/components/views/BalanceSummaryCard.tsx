import type { ReactNode } from 'react';
import { formatCredits } from '../../../core/format';
import { VprCard } from '../vpr/VprKit';
import { BalanceInfoPopover, BalanceWarning } from './BalanceBreakdown';
import type { BalanceBreakdownValues } from './balance-breakdown';
import styles from './BalanceSummaryCard.module.scss';

export function BalanceSummaryCard({ values, actions }: {
  values: BalanceBreakdownValues;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <VprCard className={styles.card}>
      <span className={styles.labelRow}>
        <span className={styles.label}>Your balance</span>
        <BalanceInfoPopover values={values} />
      </span>
      <span className={styles.valueRow}>
        <span className={styles.value}>${formatCredits(values.totalOwned)}</span>
        <BalanceWarning values={values} />
      </span>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </VprCard>
  );
}
