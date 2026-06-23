import { useState, useEffect } from 'react';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import styles from './StreamingIndicator.module.scss';

declare const __APP_VERSION__: string;

export function StreamingIndicator() {
  const { chatStreamingIndicatorText, chatStreamingActive, runtimeActivity } = useUiSelector((state) => ({
    chatStreamingIndicatorText: state.chatStreamingIndicatorText,
    chatStreamingActive: state.chatStreamingActive,
    runtimeActivity: state.runtimeActivity,
  }), shallowEqual);
  const [appVersion, setAppVersion] = useState<string>(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');

  useEffect(() => {
    const bridge = (window as unknown as { antseedDesktop?: { getAppVersion?: () => Promise<string> } }).antseedDesktop;
    bridge?.getAppVersion?.().then((v) => setAppVersion(v)).catch(() => {});
  }, []);

  return (
    <div className={`${styles.chatStreamingIndicator}${chatStreamingActive ? ` ${styles.isThinking}` : ''}`}>
      <div className={styles.statusLeft}>
        <div>
          {chatStreamingIndicatorText || 'Idle'}
        </div>
        <span>·</span>
        <div className={`runtime-activity-${runtimeActivity.tone}`} aria-live="polite">
          {runtimeActivity.message || 'Idle'}
        </div>
      </div>
      {appVersion && (
        <div className={styles.versionLabel}>v{appVersion}</div>
      )}
    </div>
  );
}
