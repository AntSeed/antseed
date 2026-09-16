import { useCallback, useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, CreditCardIcon, Download01Icon, SquareLock01Icon, Upload01Icon, Wallet01Icon } from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits, shortAddress } from '../../../core/format';
import { formatCompactTokens, VprCard, VprPage, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { BalanceSummaryCard } from './BalanceSummaryCard';
import { ExportSignerKeyDialog, ImportSignerKeyDialog } from './SignerKeyDialogs';
import { recordUserAction } from '../../../modules/telemetry/actions';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { routingDecisionsResource, savingsBaselineModelResource } from '../../../modules/app/vpr-resources';
import { computeRecentRouterSavings, SEVEN_DAYS_MS } from '../../../modules/routing/router-savings';
import { formatSavedUsd } from '../../../modules/catalog/measured-savings';
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
    wallet: state.creditsWalletUsdc,
    totalOwned: state.creditsTotalOwnedUsdc,
    creditLimit: state.creditsCreditLimitUsdc,
    evmAddress: state.creditsEvmAddress,
    operatorAddress: state.creditsOperatorAddress,
    usage: state.creditsBuyerUsage,
    rewards: state.creditsRewards,
    routerEnabled: state.vprRoutingPreferences.routerEnabled ?? false,
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


  // Only polled while a router is actually selected -- the pill itself is
  // hidden otherwise, so there's nothing for this data to feed.
  const routingDecisions = useCachedResource(routingDecisionsResource, snap.routerEnabled).data;
  const savingsBaselineModel = useCachedResource(savingsBaselineModelResource, snap.routerEnabled).data;
  const last7DaysSavings = useMemo(
    () => computeRecentRouterSavings(routingDecisions, SEVEN_DAYS_MS, Date.now(), savingsBaselineModel ?? undefined),
    [routingDecisions, savingsBaselineModel],
  );

  const balanceValues = {
    available: snap.available,
    reserved: snap.reserved,
    pending: snap.pending,
    wallet: snap.wallet,
    totalOwned: snap.totalOwned,
    creditLimit: snap.creditLimit,
    deposited: snap.total,
  };

  return (
    <section className={`view view-vpr-credits view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Profile">
      <div className={styles.stack}>

        <div className={styles.balanceGroup}>
          <BalanceSummaryCard
            values={balanceValues}
            actions={(
              <div className={styles.payButtons}>
                <button type="button" onClick={() => onSelectView?.('deposit')}>
                  <HugeiconsIcon icon={CreditCardIcon} size={16} strokeWidth={2} />
                  <HugeiconsIcon icon={Wallet01Icon} size={16} strokeWidth={2} />
                  <span>Add Credits</span>
                </button>
              </div>
            )}
          />

          <div className={styles.secureNote}>
            <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
            <span>Encrypted &amp; secure checkout</span>
          </div>

          <button
            type="button"
            className={styles.withdraw}
            onClick={() => {
              recordUserAction('withdraw_start', 'credits');
              void window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'withdraw' });
            }}
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

        {snap.routerEnabled && (
          <VprCard className={styles.rewardsCard}>
            <span className={styles.rewardsText}>
              <strong>Auto-routing savings</strong>{' '}
              {last7DaysSavings
                ? `You've saved ${formatSavedUsd(last7DaysSavings.baselineUsd - last7DaysSavings.actualUsd)} in the past 7 days`
                  + (savingsBaselineModel ? `, vs. ${savingsBaselineModel}.` : '.')
                : 'No routed savings to show yet.'}
            </span>
            <button
              type="button"
              className={styles.rewardsLink}
              onClick={() => { void window.antseedDesktop?.paymentsOpenSavingsPage?.(); }}
            >
              <span>Open details</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} />
            </button>
          </VprCard>
        )}

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
