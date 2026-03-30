import { useState, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Sun02Icon } from '@hugeicons/core-free-icons';
import { Moon02Icon } from '@hugeicons/core-free-icons';
import { AntStationLogo } from './AntStationLogo';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
import styles from './TitleBar.module.scss';

const THEME_STORAGE_KEY = 'antseed:theme';

export function TitleBar() {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved !== null) return saved === 'dark';
    return document.body.classList.contains('dark-theme');
  });
  const [updateReady, setUpdateReady] = useState<string | null>(null);

  useEffect(() => {
    if (isDark) {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
    localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    const bridge = (window as unknown as { antseedDesktop?: { onUpdateStatus?: (h: (d: { status: string; version: string }) => void) => () => void } }).antseedDesktop;
    if (!bridge?.onUpdateStatus) return;
    return bridge.onUpdateStatus((data) => {
      if (data.status === 'ready') setUpdateReady(data.version);
    });
  }, []);

  const handleUpdate = useCallback(() => {
    const bridge = (window as unknown as { antseedDesktop?: { installUpdate?: () => Promise<void> } }).antseedDesktop;
    void bridge?.installUpdate?.();
  }, []);

  const {
    creditsAvailableUsdc,
    creditsReservedUsdc,
    creditsPendingWithdrawalUsdc,
    creditsOperatorAddress,
    creditsEvmAddress,
  } = useUiSnapshot();
  const actions = useActions();
  const [creditsDropdownOpen, setCreditsDropdownOpen] = useState(false);

  const creditsDisplay = parseFloat(creditsAvailableUsdc) > 0
    ? `$${parseFloat(creditsAvailableUsdc).toFixed(2)}`
    : '$0.00';

  const handleAddCredits = useCallback(() => {
    setCreditsDropdownOpen(false);
    actions.openPaymentsPortal?.();
  }, [actions]);

  const handleManageSessions = useCallback(() => {
    setCreditsDropdownOpen(false);
    actions.openPaymentsPortal?.('sessions');
  }, [actions]);

  useEffect(() => {
    if (!creditsDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(`.${styles.titleBarCreditsWrapper}`)) {
        setCreditsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [creditsDropdownOpen]);

  return (
    <header className={styles.titleBar}>
      <div className={styles.titleBarLeft}>
        <AntStationLogo height={20} className={styles.titleBarLogo} />
      </div>
      <div className={styles.titleBarRight}>
        {updateReady && (
          <button
            className={styles.titleBarUpdateBtn}
            onClick={handleUpdate}
            aria-label={`Install v${updateReady} and restart`}
            title={`Install v${updateReady} and restart`}
          >
            Update to v{updateReady}
          </button>
        )}
        <div className={styles.titleBarCreditsWrapper}>
          <button
            className={styles.titleBarCreditsBtn}
            onClick={() => setCreditsDropdownOpen((prev) => !prev)}
            aria-label={`Credits: ${creditsDisplay}`}
            title="Credits balance"
          >
            {creditsDisplay}
          </button>
          {creditsDropdownOpen && (
            <div className={styles.titleBarCreditsDropdown}>
              <div className={styles.creditsDropdownSection}>
                <div className={styles.creditsDropdownRow}>
                  <span className={styles.creditsDropdownLabel}>Available</span>
                  <span className={styles.creditsDropdownValue}>{creditsDisplay}</span>
                </div>
                <div className={styles.creditsDropdownRow}>
                  <span className={styles.creditsDropdownLabel}>Reserved</span>
                  <span className={styles.creditsDropdownValueMuted}>${parseFloat(creditsReservedUsdc).toFixed(2)}</span>
                </div>
                {parseFloat(creditsPendingWithdrawalUsdc) > 0 && (
                  <div className={styles.creditsDropdownRow}>
                    <span className={styles.creditsDropdownLabel}>Pending Withdrawal</span>
                    <span className={styles.creditsDropdownValueMuted}>${parseFloat(creditsPendingWithdrawalUsdc).toFixed(2)}</span>
                  </div>
                )}
              </div>
              <div className={styles.creditsDropdownSection}>
                <div className={styles.creditsDropdownRow}>
                  <span className={styles.creditsDropdownLabel}>Operator</span>
                  {creditsOperatorAddress ? (
                    <span className={styles.creditsDropdownValueGreen}>
                      {creditsOperatorAddress.slice(0, 6)}...{creditsOperatorAddress.slice(-4)}
                    </span>
                  ) : (
                    <span className={styles.creditsDropdownValueWarn}>Not set</span>
                  )}
                </div>
                {creditsEvmAddress && (
                  <div className={styles.creditsDropdownRow}>
                    <span className={styles.creditsDropdownLabel}>Wallet</span>
                    <span className={styles.creditsDropdownValueMuted}>
                      {creditsEvmAddress.slice(0, 6)}...{creditsEvmAddress.slice(-4)}
                    </span>
                  </div>
                )}
              </div>
              <div className={styles.creditsDropdownActions}>
                <button className={styles.creditsDropdownAddBtn} onClick={handleAddCredits}>
                  Add Credits
                </button>
                <button className={styles.creditsDropdownManageBtn} onClick={handleManageSessions}>
                  Manage Sessions
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          className={styles.titleBarThemeToggle}
          onClick={() => setIsDark((d) => !d)}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          <HugeiconsIcon
            icon={isDark ? Sun02Icon : Moon02Icon}
            size={16}
            strokeWidth={1.5}
          />
        </button>
      </div>
    </header>
  );
}
