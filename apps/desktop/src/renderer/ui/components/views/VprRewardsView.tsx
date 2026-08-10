import { useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits } from '../../../core/format';
import { VprBadge, VprCard, VprPage } from '../vpr/VprKit';
import styles from './VprRewardsView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

/**
 * In-app $ANTS rewards (moved from the browser portal). The summary is
 * read-only; claiming transfers tokens on-chain and needs the authorized
 * wallet's signature, so the claim actions open the secure checkout page.
 */
export function VprRewardsView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    rewards: state.creditsRewards,
    loading: state.creditsSummaryLoading,
  }), shallowEqual);

  // Force-refresh on entry and whenever the window regains focus — after
  // claiming in the browser pay popup the user lands straight back here, and
  // the 55s summary throttle would otherwise show the pre-claim numbers.
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

  const rewards = snap.rewards;
  const pending = rewards?.available ? rewards.pendingAnts : '0';
  const hasPending = Number(pending) > 0;

  const openClaim = () => {
    void window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'claim' });
  };

  return (
    <section className={`view view-vpr-rewards view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Rewards" backTo="credits">
      <div className={styles.stack}>

        <VprCard className={styles.heroCard}>
          <div className={styles.heroText}>
            <span className={styles.heroLabel}>Pending $ANTS</span>
            <span className={styles.heroValue}>{formatCredits(pending)}</span>
            <span className={styles.heroHint}>
              {rewards?.available
                ? `Earned from your usage${rewards.currentEpoch !== null ? ` — epoch ${rewards.currentEpoch}` : ''}.`
                : 'Rewards are not live on this chain yet.'}
            </span>
          </div>
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.claimButton}
              disabled={!rewards?.available || !hasPending}
              onClick={openClaim}
            >
              <span>Claim rewards</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
            </button>
            {rewards?.available && (
              <VprBadge tone={rewards.transfersEnabled ? 'green' : 'neutral'}>
                {rewards.transfersEnabled ? 'Transfers live' : 'Transfers not enabled yet'}
              </VprBadge>
            )}
          </div>
        </VprCard>

        <VprCard className={styles.aboutCard}>
          <span className={styles.aboutTitle}>About $ANTS</span>
          <span className={styles.aboutText}>
            $ANTS are emitted every epoch to the buyers and sellers who moved real USDC volume on
            the network — no lockups, no staking requirement. Claiming settles on-chain and needs
            your authorized wallet&apos;s signature, so it opens in a secure browser window.
          </span>
        </VprCard>

        {rewards?.error && <span className={styles.errorNote}>{rewards.error}</span>}
      </div>
      </VprPage>
    </section>
  );
}
