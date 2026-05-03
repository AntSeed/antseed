import { useState, useEffect, useCallback } from 'react';
import styles from './TitleBar.module.scss';

export function TitleBar() {
  const [updateState, setUpdateState] = useState<
    | { status: 'downloading'; version: string; percent: number }
    | { status: 'ready'; version: string }
    | null
  >(null);

  useEffect(() => {
    const bridge = (window as unknown as { antseedDesktop?: { onUpdateStatus?: (h: (d: { status: string; version: string; percent?: number }) => void) => () => void } }).antseedDesktop;
    if (!bridge?.onUpdateStatus) return;
    return bridge.onUpdateStatus((data) => {
      if (data.status === 'ready') {
        setUpdateState({ status: 'ready', version: data.version });
      } else if (data.status === 'downloading') {
        const percent = typeof data.percent === 'number' ? data.percent : 0;
        setUpdateState((prev) => {
          if (prev?.status === 'ready') return prev;
          return { status: 'downloading', version: data.version, percent };
        });
      }
    });
  }, []);

  const handleUpdate = useCallback(() => {
    const bridge = (window as unknown as { antseedDesktop?: { installUpdate?: () => Promise<void> } }).antseedDesktop;
    void bridge?.installUpdate?.();
  }, []);

  return (
    <header className={styles.titleBar}>
      <div className={styles.titleBarLeft} />
      <div className={styles.titleBarRight}>
        {updateState && (
          updateState.status === 'ready' ? (
            <button
              className={styles.titleBarUpdateBtn}
              onClick={handleUpdate}
              aria-label={`Install v${updateState.version} and restart`}
              title={`Install v${updateState.version} and restart`}
            >
              Update to v{updateState.version}
            </button>
          ) : (
            <button
              className={`${styles.titleBarUpdateBtn} ${styles.titleBarUpdateBtnDownloading}`}
              disabled
              aria-label={`Downloading v${updateState.version} ${updateState.percent}%`}
              title={`Downloading v${updateState.version} — ${updateState.percent}%`}
            >
              <span className={styles.titleBarUpdateFill} style={{ width: `${updateState.percent}%` }} aria-hidden="true" />
              <span className={styles.titleBarUpdateLabel}>Downloading v{updateState.version} · {updateState.percent}%</span>
            </button>
          )
        )}
      </div>
    </header>
  );
}
