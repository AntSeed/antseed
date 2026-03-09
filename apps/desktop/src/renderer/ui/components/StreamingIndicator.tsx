import { useUiSnapshot } from '../hooks/useUiSnapshot';
import styles from './StreamingIndicator.module.scss';

export function StreamingIndicator() {
  const { chatStreamingIndicatorText, chatStreamingActive, runtimeActivity } = useUiSnapshot();

  return (
    <div className={`${styles.chatStreamingIndicator}${chatStreamingActive ? ` ${styles.isThinking}` : ''}`}>
      <div>
        {chatStreamingIndicatorText || 'Idle'}
      </div>
      <span>·</span>
      <div className={`runtime-activity-${runtimeActivity.tone}`} aria-live="polite">
        {runtimeActivity.message || 'Idle'}
      </div>
    </div>
  );
}
