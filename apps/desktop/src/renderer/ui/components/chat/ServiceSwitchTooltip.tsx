import styles from './ServiceSwitchTooltip.module.scss';

type ServiceSwitchTooltipProps = {
  modelCount: number;
  onDismiss: () => void;
};

export function ServiceSwitchTooltip({ modelCount, onDismiss }: ServiceSwitchTooltipProps) {
  return (
    <div className={styles.tooltip} role="dialog">
      <div className={styles.caret} />
      <p className={styles.body}>
        You can <span className={styles.accent}>switch models</span> here anytime.
        This peer offers <span className={styles.accent}>{modelCount} models</span> — click
        to browse and choose.
      </p>
      <button className={styles.gotIt} onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
