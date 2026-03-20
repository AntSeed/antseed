import styles from './LowBalanceWarning.module.scss';

type LowBalanceWarningProps = {
  visible: boolean;
  availableUsdc: string;
  onAddCredits: () => void;
};

export function LowBalanceWarning({ visible, availableUsdc, onAddCredits }: LowBalanceWarningProps) {
  if (!visible) return null;

  return (
    <div className={styles.lowBalanceWarning}>
      <span className={styles.warningText}>
        Your balance is running low (${parseFloat(availableUsdc).toFixed(2)} remaining).
        Add credits to continue using paid services.
      </span>
      <button
        className={styles.addCreditsLink}
        onClick={onAddCredits}
      >
        Add Credits
      </button>
    </div>
  );
}
