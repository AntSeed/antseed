import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import styles from './SessionApprovalCard.module.scss';

type SessionApprovalCardProps = {
  visible: boolean;
  peerName: string | null;
  amount: string;
  peerInfo: {
    reputation: number;
    sessionCount: number | null;
    disputeCount: number | null;
    networkAgeDays: number | null;
    evmAddress: string | null;
  } | null;
  loading: boolean;
  error: string | null;
  onApprove: () => void;
  onAddCredits: () => void;
  onCancel: () => void;
};

export function SessionApprovalCard({
  visible,
  peerName,
  amount,
  peerInfo,
  loading,
  error,
  onApprove,
  onAddCredits,
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
          ? <>Approve a <strong>${amount} USDC</strong> pre-deposit to start a session with <strong>{displayName}</strong>. This is reserved from your escrow balance.</>
          : <>A <strong>${amount} USDC</strong> pre-deposit is required to use <strong>{displayName}</strong>. Add credits to your escrow first.</>
        }
      </div>

      {peerInfo && (peerInfo.reputation > 0 || peerInfo.sessionCount !== null) && (
        <div className={styles.approvalStats}>
          {peerInfo.reputation > 0 && <span>{peerInfo.reputation} reputation</span>}
          {peerInfo.sessionCount !== null && <span>{peerInfo.sessionCount} sessions</span>}
          {peerInfo.networkAgeDays !== null && <span>{peerInfo.networkAgeDays}d in network</span>}
        </div>
      )}

      {error && <div className={styles.approvalError}>{error}</div>}

      <div className={styles.approvalActions}>
        {hasCredits ? (
          <button className={styles.approveBtn} onClick={onApprove} disabled={loading}>
            {loading ? 'Approving...' : 'Approve'}
          </button>
        ) : (
          <button className={styles.approveBtn} onClick={onAddCredits}>
            Add Credits
          </button>
        )}
        <button className={styles.cancelBtn} onClick={onCancel} disabled={loading}>
          Cancel
        </button>
      </div>
    </div>
  );
}
