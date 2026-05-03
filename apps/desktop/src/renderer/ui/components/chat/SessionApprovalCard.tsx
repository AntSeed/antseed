import { HugeiconsIcon } from '@hugeicons/react';
import { Award01Icon, Wallet02Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import styles from './SessionApprovalCard.module.scss';

type SessionApprovalCardProps = {
  visible: boolean;
  peerName: string | null;
  amount: string;
  peerInfo: {
    reputation: number;
    channelCount: number | null;
    disputeCount: number | null;
    networkAgeDays: number | null;
    evmAddress: string | null;
  } | null;
  error: string | null;
  onAddCredits: () => void;
  onRetry: () => void;
  onCancel: () => void;
};

export function SessionApprovalCard({
  visible,
  peerName,
  amount,
  peerInfo,
  error,
  onAddCredits,
  onRetry,
  onCancel,
}: SessionApprovalCardProps) {
  const { creditsAvailableUsdc } = useUiSnapshot();
  const balance = Number.parseFloat(creditsAvailableUsdc);
  const required = Number.parseFloat(amount || '0');
  const safeBalance = Number.isFinite(balance) ? balance : 0;
  const safeRequired = Number.isFinite(required) ? required : 0;
  const hasCredits = safeBalance > 0 && safeRequired > 0 && safeBalance >= safeRequired;

  if (!visible) return null;
  const displayName = peerName || 'this service';
  const amountLabel = safeRequired > 0 ? `$${amount} USDC` : 'a deposit';
  const balanceLabel = `$${safeBalance.toFixed(2)} USDC`;

  return (
    <div className={styles.approval} aria-live="polite">
      <div className={styles.approvalHeader}>
        <span className={styles.approvalIcon} aria-hidden="true">
          <HugeiconsIcon icon={Wallet02Icon} size={18} strokeWidth={1.7} />
        </span>
        <div className={styles.approvalHeaderText}>
          <div className={styles.approvalKicker}>Payment required</div>
          <div className={styles.approvalTitle}>
            {hasCredits ? 'Retry payment setup' : 'Add credits to continue'}
          </div>
        </div>
      </div>

      <p className={styles.approvalText}>
        {hasCredits
          ? <>Your available deposit covers <strong>{amountLabel}</strong> for <strong>{displayName}</strong>, but payment setup did not complete. Retry the chat or manage credits.</>
          : <><strong>{amountLabel}</strong> is required to start a paid session with <strong>{displayName}</strong>.</>
        }
      </p>

      <div className={styles.approvalDetails}>
        <div className={styles.approvalDetail}>
          <span className={styles.approvalDetailLabel}>Required</span>
          <span className={styles.approvalDetailValue}>{amountLabel}</span>
        </div>
        <div className={styles.approvalDetail}>
          <span className={styles.approvalDetailLabel}>Available</span>
          <span className={hasCredits ? styles.approvalDetailValue : styles.approvalDetailValueMuted}>
            {balanceLabel}
          </span>
        </div>
      </div>

      {peerInfo && (peerInfo.reputation > 0 || peerInfo.channelCount !== null || peerInfo.networkAgeDays !== null) && (
        <div className={styles.approvalStats} aria-label="Peer reputation details">
          <HugeiconsIcon icon={Award01Icon} size={14} strokeWidth={1.7} />
          {peerInfo.reputation > 0 && <span>{peerInfo.reputation} reputation</span>}
          {peerInfo.channelCount !== null && <span>{peerInfo.channelCount} channels</span>}
          {peerInfo.networkAgeDays !== null && <span>{peerInfo.networkAgeDays}d in network</span>}
        </div>
      )}

      {error && <div className={styles.approvalError}>{error}</div>}

      <div className={styles.approvalActions}>
        <button className={styles.approveBtn} onClick={hasCredits ? onRetry : onAddCredits}>
          {hasCredits ? 'Retry' : 'Add Credits'}
        </button>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
