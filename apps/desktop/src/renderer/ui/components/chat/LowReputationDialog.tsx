import { useEffect } from 'react';
import styles from './SwitchServiceDialog.module.scss';

type LowReputationDialogProps = {
  visible: boolean;
  peerLabel: string;
  scoreLabel: string;
  onContinue: () => void;
  onCancel: () => void;
};

export function LowReputationDialog({
  visible,
  peerLabel,
  scoreLabel,
  onContinue,
  onCancel,
}: LowReputationDialogProps) {
  useEffect(() => {
    if (!visible) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [visible, onCancel]);

  if (!visible) return null;

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className={styles.title}>Low reputation peer</h3>
        <p className={styles.body}>
          <strong>{peerLabel || 'This peer'}</strong> has a lower on-chain activity score
          {scoreLabel ? <> of <strong>{scoreLabel}</strong></> : null}. Newer or lower-volume
          peers can still be useful, but they have less settled-volume history on AntSeed.
        </p>
        <p className={styles.body}>
          Continue only if you&apos;re comfortable trying this peer.
        </p>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={onCancel}>
            Cancel
          </button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={onContinue}>
            Continue anyway
          </button>
        </div>
      </div>
    </div>
  );
}
