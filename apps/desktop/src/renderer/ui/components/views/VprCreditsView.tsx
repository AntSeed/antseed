import { useCallback, useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, CreditCardIcon, Download01Icon, SquareLock01Icon, Upload01Icon, Wallet01Icon } from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits, shortAddress } from '../../../core/format';
import { formatCompactTokens, VprCard, VprPage, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { setDepositIntent, type DepositMethod } from '../../lib/depositIntent';
import { ExportSignerKeyDialog, ImportSignerKeyDialog } from './SignerKeyDialogs';
import styles from './VprCreditsView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

export function VprCreditsView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    available: state.creditsAvailableUsdc,
    reserved: state.creditsReservedUsdc,
    total: state.creditsTotalUsdc,
    pending: state.creditsPendingUsdc,
    spendable: state.creditsSpendableUsdc,
    evmAddress: state.creditsEvmAddress,
    operatorAddress: state.creditsOperatorAddress,
    usage: state.creditsBuyerUsage,
    rewards: state.creditsRewards,
  }), shallowEqual);
  // Local to the button: background pollers (floating pill, payment events)
  // also refresh the summary, and mirroring their in-flight state here made
  // the button flip to "Refreshing..." constantly while traffic flowed.
  const [refreshing, setRefreshing] = useState(false);
  const [exportKeyOpen, setExportKeyOpen] = useState(false);
  const [importKeyOpen, setImportKeyOpen] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([actions.refreshCredits(), actions.refreshPaymentSummary(true)]);
    } finally {
      setRefreshing(false);
    }
  }, [actions]);

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
    <section className={`view view-vpr-credits view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Balance" backFallback="home">
      <div className={styles.stack}>

        <div className={styles.balanceGroup}>
          <VprCard className={styles.balanceCard}>
            <div className={styles.balanceText}>
              <span className={styles.balanceLabel}>Your balance</span>
              <span className={styles.balanceValue}>${formatCredits(snap.spendable)}</span>
              <span className={styles.balanceHint}>
                Everything you have on deposit, less the spend you have already authorized.
              </span>
            </div>
            <div className={styles.payButtons}>
              <button type="button" onClick={() => openDeposit('card')}>
                <HugeiconsIcon icon={CreditCardIcon} size={16} strokeWidth={2} />
                <span>Credit Card</span>
              </button>
              <button type="button" onClick={() => openDeposit('crypto')}>
                <HugeiconsIcon icon={Wallet01Icon} size={16} strokeWidth={2} />
                <span>USDC on Base</span>
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

        {/* Where the money sits. Reserving a channel moves deposits into the
            "held" bucket without spending them, and a signed SpendingAuth
            spends without moving anything until the seller settles — so
            neither number alone answers "how much do I have left?". */}
        <VprCard className={styles.detailsCard}>
          <div className={styles.detailRow}>
            <span>Ready to use</span><span>${formatCredits(snap.available)}</span>
          </div>
          <div className={styles.detailRow}>
            <span>Held in open sessions</span><span>${formatCredits(snap.reserved)}</span>
          </div>
          <div className={styles.detailRow}>
            <span>Authorized, not yet charged</span>
            <span>{Number(snap.pending) > 0 ? '-' : ''}${formatCredits(snap.pending)}</span>
          </div>
          <div className={`${styles.detailRow} ${styles.detailRowTotal}`}>
            <span>Total deposited</span><span>${formatCredits(snap.total)}</span>
          </div>
        </VprCard>

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
            onClick={() => onSelectView?.('rewards')}
          >
            <span>Rewards</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} />
          </button>
        </VprCard>

        <VprCard className={styles.rewardsCard}>
          <span className={styles.rewardsText}>
            <strong>Payment channels</strong>{' '}
            {`${snap.usage?.activeChannels ?? 0} active — see settlements or close a channel.`}
          </span>
          <button
            type="button"
            className={styles.rewardsLink}
            onClick={() => onSelectView?.('activity')}
          >
            <span>Activity</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} />
          </button>
        </VprCard>

        <VprCard className={styles.detailsCard}>
          <div className={styles.detailRow}>
            <span>Signer</span>
            <span className={styles.signerValue}>
              <button
                type="button"
                className={styles.keyAction}
                title="Back up private key"
                aria-label="Back up private key"
                onClick={() => setExportKeyOpen(true)}
              >
                <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={styles.keyAction}
                title="Import private key"
                aria-label="Import private key"
                onClick={() => setImportKeyOpen(true)}
              >
                <HugeiconsIcon icon={Upload01Icon} size={14} strokeWidth={2} />
              </button>
              {shortAddress(snap.evmAddress)}
            </span>
          </div>
          <div className={styles.detailRow}>
            <span>Wallet</span>
            {snap.operatorAddress ? (
              <span>{shortAddress(snap.operatorAddress)}</span>
            ) : (
              <button
                type="button"
                className={styles.inlineLink}
                onClick={() => window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'authorize' })}
              >
                Authorize a wallet
              </button>
            )}
          </div>
          {/* <div className={styles.detailActions}>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => { void refresh(); }}
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div> */}
        </VprCard>
      </div>
      </VprPage>
      <ExportSignerKeyDialog isOpen={exportKeyOpen} onClose={() => setExportKeyOpen(false)} />
      <ImportSignerKeyDialog
        isOpen={importKeyOpen}
        onClose={() => setImportKeyOpen(false)}
        onImported={() => { void refresh(); }}
      />
    </section>
  );
}
