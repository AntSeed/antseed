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

  const displayName = peerName || 'Unknown peer';

  return (
    <div className={styles.approvalCard}>
      <div className={styles.approvalHeader}>
        <span className={styles.approvalTitle}>Session Approval Required</span>
      </div>

      {peerInfo && (
        <div className={styles.peerStats}>
          <div className={styles.statItem}>
            <span className={styles.statValue}>{peerInfo.reputation}</span>
            <span className={styles.statLabel}>Reputation</span>
          </div>
          {peerInfo.sessionCount !== null && (
            <div className={styles.statItem}>
              <span className={styles.statValue}>{peerInfo.sessionCount}</span>
              <span className={styles.statLabel}>Sessions</span>
            </div>
          )}
          {peerInfo.networkAgeDays !== null && (
            <div className={styles.statItem}>
              <span className={styles.statValue}>{peerInfo.networkAgeDays}d</span>
              <span className={styles.statLabel}>In Network</span>
            </div>
          )}
          {peerInfo.disputeCount !== null && peerInfo.disputeCount > 0 && (
            <div className={`${styles.statItem} ${styles.statWarn}`}>
              <span className={styles.statValue}>{peerInfo.disputeCount}</span>
              <span className={styles.statLabel}>Disputes</span>
            </div>
          )}
        </div>
      )}

      <p className={styles.approvalMessage}>
        To start your session, approve a pre-deposit of{' '}
        <strong>${amount}</strong> to{' '}
        <strong>{displayName}</strong>.
        This is deducted from your credits.
      </p>

      {error && (
        <div className={styles.approvalError}>{error}</div>
      )}

      <div className={styles.approvalActions}>
        <button
          className={styles.approveBtn}
          onClick={onApprove}
          disabled={loading}
        >
          {loading ? 'Signing...' : 'Approve'}
        </button>
        <button
          className={styles.cancelBtn}
          onClick={onCancel}
          disabled={loading}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
