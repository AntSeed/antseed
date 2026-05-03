import { useState, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Sun02Icon } from '@hugeicons/core-free-icons';
import { Moon02Icon } from '@hugeicons/core-free-icons';
import { Wallet02Icon } from '@hugeicons/core-free-icons';
import { Copy01Icon } from '@hugeicons/core-free-icons';
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
import styles from './TitleBar.module.scss';

const THEME_STORAGE_KEY = 'antseed:theme';

const CHAIN_LABELS: Record<string, string> = {
  'base-sepolia': 'Base Sepolia',
  'base-mainnet': 'Base Mainnet',
  'base-local': 'Local',
};

function CopyAddressButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard write can fail in restricted contexts; fail silently
    }
  }, [value]);

  return (
    <button
      type="button"
      className={styles.creditsDropdownCopyBtn}
      onClick={handleCopy}
      aria-label={copied ? `${label} address copied` : `Copy ${label} address`}
      title={copied ? 'Copied' : 'Copy address'}
    >
      <HugeiconsIcon
        icon={copied ? Tick02Icon : Copy01Icon}
        size={12}
        strokeWidth={2}
      />
    </button>
  );
}

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

  const handleConnectWallet = useCallback(() => {
    setCreditsDropdownOpen(false);
    actions.openPaymentsPortal?.();
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
        <div className={styles.titleBarCreditsWrapper}>
          <button
            className={styles.titleBarCreditsBtn}
            onClick={() => setCreditsDropdownOpen((prev) => !prev)}
            aria-label={`Wallet balance: ${creditsDisplay}`}
            title="Wallet balance"
          >
            <HugeiconsIcon
              icon={Wallet02Icon}
              size={14}
              strokeWidth={1.75}
              className={styles.titleBarCreditsIcon}
            />
            <span className={styles.titleBarCreditsAmount}>{creditsDisplay}</span>
          </button>
          {creditsDropdownOpen && (
            <div className={styles.titleBarCreditsDropdown} role="menu">
              <div className={styles.creditsDropdownBalanceSection}>
                <div className={styles.creditsDropdownHero}>
                  <span className={styles.creditsDropdownHeroAmount}>{creditsDisplay}</span>
                  <span className={styles.creditsDropdownHeroUnit}>USDC available</span>
                </div>
                <div className={styles.creditsDropdownReservedRow}>
                  <span className={styles.creditsDropdownReservedLabel}>Reserved</span>
                  <span className={styles.creditsDropdownReservedValue}>
                    ${parseFloat(creditsReservedUsdc).toFixed(2)}
                  </span>
                </div>
              </div>

              <div className={styles.creditsDropdownDivider} aria-hidden="true" />

              <div className={styles.creditsDropdownIdentitySection}>
                {creditsOperatorAddress ? (
                  <div className={styles.creditsDropdownIdentityRow}>
                    <span className={styles.creditsDropdownIdentityLabel}>Wallet</span>
                    <span className={styles.creditsDropdownAddressGroup}>
                      <span className={styles.creditsDropdownAddressChip}>
                        {creditsOperatorAddress.slice(0, 6)}…{creditsOperatorAddress.slice(-4)}
                      </span>
                      <CopyAddressButton value={creditsOperatorAddress} label="Wallet" />
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.creditsDropdownConnectCta}
                    onClick={handleConnectWallet}
                  >
                    <span className={styles.creditsDropdownConnectIcon} aria-hidden="true">
                      <HugeiconsIcon icon={Wallet02Icon} size={14} strokeWidth={1.75} />
                    </span>
                    <span className={styles.creditsDropdownConnectText}>
                      <span className={styles.creditsDropdownConnectTitle}>Connect a wallet</span>
                      <span className={styles.creditsDropdownConnectSubtitle}>Link an address to deposit USDC</span>
                    </span>
                    <span className={styles.creditsDropdownConnectArrow} aria-hidden="true">
                      <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} />
                    </span>
                  </button>
                )}
                {creditsEvmAddress && (
                  <div className={styles.creditsDropdownIdentityRow}>
                    <span className={styles.creditsDropdownIdentityLabel}>Signer</span>
                    <span className={styles.creditsDropdownAddressGroup}>
                      <span className={styles.creditsDropdownAddressChipMuted}>
                        {creditsEvmAddress.slice(0, 6)}…{creditsEvmAddress.slice(-4)}
                      </span>
                      <CopyAddressButton value={creditsEvmAddress} label="Signer" />
                    </span>
                  </div>
                )}
              </div>

              <div className={styles.creditsDropdownActions}>
                <button
                  className={styles.creditsDropdownManageBtn}
                  onClick={handleManageCredits}
                  type="button"
                >
                  Manage
                </button>
                <button
                  className={styles.creditsDropdownAddBtn}
                  onClick={handleDepositCredits}
                  type="button"
                >
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
