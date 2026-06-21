import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Sun02Icon } from '@hugeicons/core-free-icons';
import { Moon02Icon } from '@hugeicons/core-free-icons';
import { Button } from '@antseed/ui';
import { AntStationLogo } from './AntStationLogo';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
import type { UpdateStatus } from '../../types/bridge';
import styles from './TitleBar.module.scss';

const THEME_STORAGE_KEY = 'antseed:theme';
const DEFAULT_UPDATE_INSTALL_HINT = 'Quit AntSeed, reopen, and try again.';

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
    UpdateStatus | null
  >(null);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const [detailsCopied, setDetailsCopied] = useState(false);

  useEffect(() => {
    if (isDark) {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
    localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    const bridge = window.antseedDesktop;
    if (!bridge?.onUpdateStatus) return;
    return bridge.onUpdateStatus((data) => {
      if (data.status === 'error') {
        setErrorDetailsOpen(true);
        setUpdateState(data);
        return;
      }
      setErrorDetailsOpen(false);
      setDetailsCopied(false);
      if (data.status === 'downloading') {
        setUpdateState((prev) => {
          if (prev?.status === 'ready') return prev;
          return data;
        });
        return;
      }
      setUpdateState(data);
    });
  }, []);

  const showUpdateError = useCallback((message: string, details: string, hint?: string) => {
    setUpdateState((prev) => ({
      status: 'error',
      version: prev?.version ?? null,
      message,
      details,
      hint: hint ?? DEFAULT_UPDATE_INSTALL_HINT,
    }));
    setErrorDetailsOpen(true);
  }, []);

  const handleUpdate = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.installUpdate) {
      showUpdateError('Desktop updater is unavailable.', 'window.antseedDesktop.installUpdate is not available.');
      return;
    }

    setUpdateState((prev) => {
      if (prev?.status !== 'ready') return prev;
      return { status: 'installing', version: prev.version };
    });

    try {
      const result = await bridge.installUpdate();
      if (!result.ok) {
        showUpdateError(result.error, result.details, result.hint);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed to install.';
      const details = err instanceof Error ? (err.stack || err.message) : String(err);
      showUpdateError(message, details);
    }
  }, [showUpdateError]);

  const handleCopyUpdateDetails = useCallback(() => {
    if (updateState?.status !== 'error') return;
    const detailText = [
      `Message: ${updateState.message}`,
      updateState.hint ? `Hint: ${updateState.hint}` : null,
      `Details: ${updateState.details}`,
    ].filter(Boolean).join('\n');
    void navigator.clipboard.writeText(detailText).then(() => {
      setDetailsCopied(true);
      window.setTimeout(() => setDetailsCopied(false), 1500);
    }).catch(() => {
      setDetailsCopied(false);
    });
  }, [updateState]);

  const {
    creditsAvailableUsdc,
    creditsReservedUsdc,
    creditsOperatorAddress,
    creditsEvmAddress,
    configFormData,
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

  let updateControl: ReactNode = null;
  if (updateState?.status === 'ready') {
    updateControl = (
      <button
        className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeReady}`}
        onClick={handleUpdate}
        aria-label={`Install v${updateState.version} and restart`}
        title={`Click to install v${updateState.version} and restart`}
      >
        <span className={styles.titleBarUpdateDot} />
        Update to v{updateState.version}
      </button>
    );
  } else if (updateState?.status === 'downloading') {
    updateControl = (
      <button
        className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeDownloading}`}
        disabled
        aria-label={`Downloading v${updateState.version} ${updateState.percent}%`}
        title={`Downloading v${updateState.version} - ${updateState.percent}%`}
      >
        <span className={styles.titleBarUpdateFill} style={{ width: `${updateState.percent}%` }} aria-hidden="true" />
        <span className={styles.titleBarUpdateLabel}>
          <span className={styles.titleBarUpdateDot} />
          Downloading v{updateState.version} · {updateState.percent}%
        </span>
      </button>
    );
  } else if (updateState?.status === 'installing') {
    updateControl = (
      <button
        className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeDownloading}`}
        disabled
        aria-label="Installing update and restarting"
        title="Installing update and restarting"
      >
        <span className={styles.titleBarUpdateLabel}>
          <span className={styles.titleBarUpdateDot} />
          Installing update
        </span>
      </button>
    );
  } else if (updateState?.status === 'error') {
    updateControl = (
      <div className={styles.titleBarUpdateErrorWrap}>
        <button
          className={`${styles.titleBarUpdateBadge} ${styles.titleBarUpdateBadgeError}`}
          onClick={() => setErrorDetailsOpen((prev) => !prev)}
          aria-expanded={errorDetailsOpen}
          aria-label="Update failed. Show details"
          title={updateState.message}
        >
          <span className={styles.titleBarUpdateDot} />
          Update failed
        </button>
        {errorDetailsOpen && (
          <div className={styles.titleBarUpdateErrorPanel} role="alert">
            <div className={styles.titleBarUpdateErrorTitle}>Update failed to install</div>
            <p>{updateState.hint ?? DEFAULT_UPDATE_INSTALL_HINT}</p>
            <div className={styles.titleBarUpdateErrorMessage}>{updateState.message}</div>
            <pre>{updateState.details}</pre>
            <div className={styles.titleBarUpdateErrorActions}>
              <button type="button" onClick={handleCopyUpdateDetails}>
                {detailsCopied ? 'Copied' : 'Copy details'}
              </button>
              <button type="button" onClick={() => setErrorDetailsOpen(false)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <header className={styles.titleBar}>
      <div className={styles.titleBarLeft}>
        <AntStationLogo height={20} className={styles.titleBarLogo} />
      </div>
      <div className={styles.titleBarRight}>
        {updateControl && (
          <div className={styles.titleBarCenter}>
            {updateControl}
          </div>
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
                <Button
                  className={styles.creditsDropdownManageBtn}
                  size="sm"
                  variant="outline"
                  onClick={handleManageCredits}
                >
                  Portal
                </Button>
                <Button
                  className={styles.creditsDropdownAddBtn}
                  size="sm"
                  onClick={handleDepositCredits}
                >
                  Deposit
                </Button>
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
