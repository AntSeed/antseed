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
  const balance = parseFloat(creditsAvailableUsdc);
  const required = parseFloat(amount || '0');
  const hasCredits = balance > 0 && balance >= required;

  if (!visible) return null;
  const displayName = peerName || 'this service';

  return (
    <div className={styles.approval}>
      <div className={styles.approvalText}>
        {hasCredits
          ? <>Payment setup failed even though your available deposit balance covers <strong>${amount} USDC</strong> for <strong>{displayName}</strong>. Retry the chat, or manage credits if the problem persists.</>
          : <>A <strong>${amount} USDC</strong> pre-deposit is required to use <strong>{displayName}</strong>. Add credits to your deposits first.</>
        }
      </div>

      {peerInfo && (peerInfo.reputation > 0 || peerInfo.channelCount !== null) && (
        <div className={styles.approvalStats}>
          {peerInfo.reputation > 0 && <span>{peerInfo.reputation} reputation</span>}
          {peerInfo.channelCount !== null && <span>{peerInfo.channelCount} channels</span>}
          {peerInfo.networkAgeDays !== null && <span>{peerInfo.networkAgeDays}d in network</span>}
        </div>
      )}

      {error && <div className={styles.approvalError}>{error}</div>}

      <div className={styles.approvalActions}>
        {hasCredits ? (
          <>
            <button className={styles.approveBtn} onClick={onRetry}>
              Retry
            </button>
            <button className={styles.cancelBtn} onClick={onCancel}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className={styles.approveBtn} onClick={onAddCredits}>
              Add Credits
            </button>
            <button className={styles.cancelBtn} onClick={onCancel}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
