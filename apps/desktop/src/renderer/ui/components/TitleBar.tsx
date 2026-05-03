import { useState, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Sun02Icon } from '@hugeicons/core-free-icons';
import { Moon02Icon } from '@hugeicons/core-free-icons';
import { AntStationLogo } from './AntStationLogo';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
import type { ExperienceMode } from '../../core/state';
import styles from './TitleBar.module.scss';

const THEME_STORAGE_KEY = 'antseed:theme';

const CHAIN_LABELS: Record<string, string> = {
  'base-sepolia': 'Base Sepolia',
  'base-mainnet': 'Base Mainnet',
  'base-local': 'Local',
};

export function TitleBar() {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved !== null) return saved === 'dark';
    return document.body.classList.contains('dark-theme');
  });
  const [updateState, setUpdateState] = useState<
    | { status: 'downloading'; version: string; percent: number }
    | { status: 'ready'; version: string }
    | null
  >(null);

  useEffect(() => {
    if (isDark) {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
    localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
  }, [isDark]);

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

  const {
    creditsAvailableUsdc,
    creditsReservedUsdc,
    creditsOperatorAddress,
    creditsEvmAddress,
    configFormData,
    experienceMode,
  } = useUiSnapshot();
  const actions = useActions();
  const [creditsDropdownOpen, setCreditsDropdownOpen] = useState(false);

  const chainId = configFormData?.cryptoChainId || 'base-mainnet';
  const chainLabel = CHAIN_LABELS[chainId] ?? chainId;

  const creditsDisplay = parseFloat(creditsAvailableUsdc) > 0
    ? `$${parseFloat(creditsAvailableUsdc).toFixed(2)}`
    : '$0.00';

  const handleManageCredits = useCallback(() => {
    setCreditsDropdownOpen(false);
    actions.openPaymentsPortal?.();
  }, [actions]);

  const handleDepositCredits = useCallback(() => {
    setCreditsDropdownOpen(false);
    actions.openPaymentsPortal?.('deposit');
  }, [actions]);

  const handleSetExperienceMode = useCallback((mode: ExperienceMode) => {
    actions.setExperienceMode(mode);
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
        <div className={styles.modeToggle} role="group" aria-label="Experience mode">
          <button
            className={`${styles.modeToggleBtn}${experienceMode === 'code' ? ` ${styles.modeToggleBtnActive}` : ''}`}
            onClick={() => handleSetExperienceMode('code')}
            aria-pressed={experienceMode === 'code'}
          >
            Code Mode
          </button>
          <button
            className={`${styles.modeToggleBtn}${experienceMode === 'studio' ? ` ${styles.modeToggleBtnActive}` : ''}`}
            onClick={() => handleSetExperienceMode('studio')}
            aria-pressed={experienceMode === 'studio'}
          >
            Studio Mode
          </button>
        </div>
        <div className={styles.alphaHint}>
          Alpha Version
        </div>
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
              </div>
              <div className={styles.creditsDropdownSection}>
                <div className={styles.creditsDropdownRow}>
                  <span className={styles.creditsDropdownLabel}>Your Wallet</span>
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
                    <span className={styles.creditsDropdownLabel}>Your Signer</span>
                    <span className={styles.creditsDropdownValueMuted}>
                      {creditsEvmAddress.slice(0, 6)}...{creditsEvmAddress.slice(-4)}
                    </span>
                  </div>
                )}
              </div>
              <div className={styles.creditsDropdownActions}>
                <button className={styles.creditsDropdownManageBtn} onClick={handleManageCredits}>
                  Manage
                </button>
                <button className={styles.creditsDropdownAddBtn} onClick={handleDepositCredits}>
                  Deposit
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
