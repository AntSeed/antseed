import { useEffect } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { shortAddress } from '../../../core/format';
import styles from './VprCreditsView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

export function VprCreditsView(_props: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    available: state.creditsAvailableUsdc,
    reserved: state.creditsReservedUsdc,
    total: state.creditsTotalUsdc,
    creditLimit: state.creditsCreditLimitUsdc,
    evmAddress: state.creditsEvmAddress,
    operatorAddress: state.creditsOperatorAddress,
    usage: state.creditsBuyerUsage,
    channels: state.creditsChannels,
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

  return (
    <section className={`view view-vpr-credits ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <div className={styles.header}>
          <span>Credits</span>
          <h2 className={styles.title}>Payments</h2>
        </div>

        <div className={styles.grid}>
          <div className={styles.tile}><div className={styles.label}>Available</div><div className={styles.value}>${snap.available}</div></div>
          <div className={styles.tile}><div className={styles.label}>Reserved</div><div className={styles.value}>${snap.reserved}</div></div>
          <div className={styles.tile}><div className={styles.label}>Total</div><div className={styles.value}>${snap.total}</div></div>
          <div className={styles.tile}><div className={styles.label}>Credit limit</div><div className={styles.value}>${snap.creditLimit}</div></div>
        </div>

        <div className={styles.section}>
          <div className={styles.row}><span>Wallet</span><span>{shortAddress(snap.evmAddress)}</span></div>
          <div className={styles.row}><span>Operator</span><span>{shortAddress(snap.operatorAddress)}</span></div>
        </div>

        <div className={styles.section}>
          <strong>Usage</strong>
          <div className={styles.row}><span>Requests</span><span>{snap.usage?.totalRequests ?? 0}</span></div>
          <div className={styles.row}><span>Input tokens</span><span>{snap.usage?.totalInputTokens ?? '0'}</span></div>
          <div className={styles.row}><span>Output tokens</span><span>{snap.usage?.totalOutputTokens ?? '0'}</span></div>
          <div className={styles.row}><span>Settlements</span><span>{snap.usage?.totalSettlements ?? 0}</span></div>
          <div className={styles.row}><span>Active channels</span><span>{snap.usage?.activeChannels ?? 0}</span></div>
        </div>

        <div className={styles.section}>
          <strong>Channels</strong>
          {snap.channels.length === 0 ? <span className={styles.label}>No channel activity</span> : snap.channels.slice(0, 5).map((channel) => (
            <div key={channel.channelId} className={styles.row}>
              <span>{channel.peerId || shortAddress(channel.seller)}</span>
              <span>{channel.status} · {channel.requestCount}</span>
            </div>
          ))}
        </div>

        <div className={styles.section}>
          <strong>Rewards</strong>
          <div className={styles.row}><span>Pending ANTS</span><span>{snap.rewards?.pendingAnts ?? '0'}</span></div>
          <div className={styles.row}><span>Epoch</span><span>{snap.rewards?.currentEpoch ?? 'n/a'}</span></div>
          <div className={styles.row}><span>Transfers</span><span>{snap.rewards?.transfersEnabled ? 'Enabled' : 'Locked'}</span></div>
        </div>

        <div className={styles.actions}>
          <button type="button" onClick={() => actions.openPaymentsPortal?.('deposit')}>Deposit</button>
          <button type="button" onClick={() => actions.openPaymentsPortal?.('channels')}>Activity</button>
          <button type="button" onClick={() => actions.openPaymentsPortal?.('rewards')}>Rewards</button>
          <button type="button" disabled={snap.loading} onClick={() => { actions.refreshCredits(); actions.refreshPaymentSummary(true); }}>Refresh</button>
        </div>
      </div>
    </section>
  );
}
