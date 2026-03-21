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
    <div className={styles.bubbleWrapper}>
      <div className={styles.bubbleAvatar}>
        <span className={styles.bubbleAvatarLetter}>{displayName.charAt(0).toUpperCase()}</span>
      </div>
      <div className={styles.bubble}>
        <div className={styles.bubbleName}>{displayName}</div>

        {peerInfo && (
          <div className={styles.peerStats}>
            <span className={styles.statChip}>{peerInfo.reputation} rep</span>
            {peerInfo.sessionCount !== null && (
              <span className={styles.statChip}>{peerInfo.sessionCount} sessions</span>
            )}
            {peerInfo.networkAgeDays !== null && (
              <span className={styles.statChip}>{peerInfo.networkAgeDays}d in network</span>
            )}
            {peerInfo.disputeCount !== null && peerInfo.disputeCount > 0 && (
              <span className={`${styles.statChip} ${styles.statChipWarn}`}>{peerInfo.disputeCount} disputes</span>
            )}
          </div>
        )}

        <p className={styles.bubbleText}>
          To start your session, approve a pre-deposit of{' '}
          <strong>${amount}</strong>.
          This is deducted from your credits.
        </p>

        {error && (
          <div className={styles.bubbleError}>{error}</div>
        )}

        <div className={styles.bubbleActions}>
          <button
            className={styles.approveBtn}
            onClick={onApprove}
            disabled={loading}
          >
            {loading ? 'Approving...' : 'Approve'}
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
    </div>
  );
}
