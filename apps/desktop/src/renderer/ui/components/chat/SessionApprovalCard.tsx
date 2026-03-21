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
  onCancel,
}: SessionApprovalCardProps) {
  if (!visible) return null;

  const displayName = peerName || 'Peer';

  return (
    <div className={styles.approval}>
      <div className={styles.approvalMeta}>{displayName}</div>

      {peerInfo && (peerInfo.reputation > 0 || peerInfo.sessionCount !== null) && (
        <div className={styles.approvalStats}>
          {peerInfo.reputation > 0 && <span>{peerInfo.reputation} reputation</span>}
          {peerInfo.sessionCount !== null && <span>{peerInfo.sessionCount} sessions</span>}
          {peerInfo.networkAgeDays !== null && <span>{peerInfo.networkAgeDays}d in network</span>}
        </div>
      )}

      <div className={styles.approvalText}>
        To start your session, approve a pre-deposit of <strong>${amount}</strong> to <strong>{displayName}</strong>. This is deducted from your credits.
      </div>

      {error && <div className={styles.approvalError}>{error}</div>}

      <div className={styles.approvalActions}>
        <button className={styles.approveBtn} onClick={onApprove} disabled={loading}>
          {loading ? 'Approving...' : 'Approve'}
        </button>
        <button className={styles.cancelBtn} onClick={onCancel} disabled={loading}>
          Cancel
        </button>
      </div>
    </div>
  );
}
