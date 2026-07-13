import { useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon, CreditCardIcon, SquareLock01Icon, Wallet01Icon } from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits, shortAddress } from '../../../core/format';
import { formatCompactTokens, VprBackTitle, VprCard, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { setDepositIntent, type DepositMethod } from '../../lib/depositIntent';
import styles from './VprCreditsView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

export function VprCreditsView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    available: state.creditsAvailableUsdc,
    reserved: state.creditsReservedUsdc,
    total: state.creditsTotalUsdc,
    evmAddress: state.creditsEvmAddress,
    operatorAddress: state.creditsOperatorAddress,
    usage: state.creditsBuyerUsage,
    rewards: state.creditsRewards,
    loading: state.creditsLoading || state.creditsSummaryLoading,
  }), shallowEqual);

  // Drive the payment-summary poll only while this view is mounted. The
  // module-level 55s self-throttle absorbs mount/focus bursts while still
  // letting a fresh mount after staleness refresh immediately.
  useEffect(() => {
    actions.refreshPaymentSummary();
    const timer = window.setInterval(() => actions.refreshPaymentSummary(), PAYMENT_SUMMARY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [actions]);

  const openDeposit = (method: DepositMethod) => {
    setDepositIntent(method);
    onSelectView?.('deposit');
  };

  return (
    <section className={`view view-vpr-credits ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <VprBackTitle title="Balance" onBack={() => onSelectView?.('home')} />

        <div className={styles.balanceGroup}>
          <VprCard className={styles.balanceCard}>
            <div className={styles.balanceText}>
              <span className={styles.balanceLabel}>Available balance</span>
              <span className={styles.balanceValue}>${formatCredits(snap.available)}</span>
              <span className={styles.balanceHint}>Pay only for what you use - no subscriptions, no lock-in.</span>
            </div>
            <div className={styles.payButtons}>
              <button type="button" onClick={() => openDeposit('card')}>
                <HugeiconsIcon icon={CreditCardIcon} size={16} strokeWidth={2} />
                <span>Credit Card</span>
              </button>
              <button type="button" onClick={() => openDeposit('crypto')}>
                <HugeiconsIcon icon={Wallet01Icon} size={16} strokeWidth={2} />
                <span>Crypto</span>
              </button>
            </div>
          </VprCard>

          <div className={styles.secureNote}>
            <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
            <span>Encrypted &amp; secure checkout</span>
          </div>

          <button
            type="button"
            className={styles.withdraw}
            onClick={() => window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'withdraw' })}
          >
            Withdraw unused credits
          </button>
        </div>

        <VprStatRow>
          <VprStatTile label="Requests" value={(snap.usage?.totalRequests ?? 0).toLocaleString('en-US')} />
          <VprStatTile
            label="Tokens"
            value={formatCompactTokens(snap.usage?.totalInputTokens, snap.usage?.totalOutputTokens)}
          />
          <VprStatTile label="Sellers" value={snap.usage?.uniqueSellers ?? 0} />
        </VprStatRow>

        <VprCard className={styles.rewardsCard}>
          <span className={styles.rewardsText}>
            <strong>Network rewards</strong>{' '}
            {snap.rewards?.available
              ? `${formatCredits(snap.rewards.pendingAnts)} ANTS pending this epoch from your usage.`
              : 'Earn ANTS from your usage once rewards go live on this chain.'}
          </span>
          <button
            type="button"
            className={styles.rewardsLink}
            onClick={() => actions.openPaymentsPortal?.('rewards')}
          >
            <span>Portal</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} />
          </button>
        </VprCard>

        <VprCard className={styles.detailsCard}>
          <div className={styles.detailRow}><span>Reserved</span><span>${formatCredits(snap.reserved)}</span></div>
          <div className={styles.detailRow}><span>Total</span><span>${formatCredits(snap.total)}</span></div>
          <div className={styles.detailRow}><span>Wallet</span><span>{shortAddress(snap.evmAddress)}</span></div>
          <div className={styles.detailRow}><span>Operator</span><span>{shortAddress(snap.operatorAddress)}</span></div>
          <div className={styles.detailActions}>
            <button
              type="button"
              disabled={snap.loading}
              onClick={() => { actions.refreshCredits(); actions.refreshPaymentSummary(true); }}
            >
              {snap.loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </VprCard>
      </div>
    </section>
  );
}
