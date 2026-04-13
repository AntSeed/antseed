import { useEffect, useState } from 'react';
import styles from './SwitchServiceDialog.module.scss';

type SwitchServiceDialogProps = {
  visible: boolean;
  currentLabel: string;
  nextLabel: string;
  onContinue: (dontShowAgain: boolean) => void;
  onStartNew: (dontShowAgain: boolean) => void;
  onCancel: () => void;
};

export function SwitchServiceDialog({
  visible,
  currentLabel,
  nextLabel,
  onContinue,
  onStartNew,
  onCancel,
}: SwitchServiceDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (visible) setDontShowAgain(false);
  }, [visible]);

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
        <h3 className={styles.title}>Switch service?</h3>
        <p className={styles.body}>
          You&apos;re switching from <strong>{currentLabel}</strong> to <strong>{nextLabel}</strong>.
          Starting a new chat usually gives better results — different models handle
          conversation context differently.
        </p>
        <label className={styles.dontShowRow}>
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Don&apos;t show this again
        </label>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={() => onContinue(dontShowAgain)}>
            Continue in this chat
          </button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => onStartNew(dontShowAgain)}>
            Start new chat
          </button>
        </div>
      </div>
    </div>
  );
}
