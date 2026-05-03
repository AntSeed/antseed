import { useState, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Wallet02Icon } from '@hugeicons/core-free-icons';
import { Copy01Icon } from '@hugeicons/core-free-icons';
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
import styles from './TitleBar.module.scss';

export function CopyAddressButton({ value, label }: { value: string; label: string }) {
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

export function WalletPanel({ onAction }: { onAction?: () => void }) {
  const {
    creditsAvailableUsdc,
    creditsReservedUsdc,
    creditsOperatorAddress,
    creditsEvmAddress,
  } = useUiSnapshot();
  const actions = useActions();

  const creditsDisplay = parseFloat(creditsAvailableUsdc) > 0
    ? `$${parseFloat(creditsAvailableUsdc).toFixed(2)}`
    : '$0.00';

  const handleManage = useCallback(() => {
    onAction?.();
    actions.openPaymentsPortal?.();
  }, [actions, onAction]);

  const handleDeposit = useCallback(() => {
    onAction?.();
    actions.openPaymentsPortal?.('deposit');
  }, [actions, onAction]);

  const handleConnect = useCallback(() => {
    onAction?.();
    actions.openPaymentsPortal?.();
  }, [actions, onAction]);

  return (
    <>
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
            onClick={handleConnect}
          >
            <span className={styles.creditsDropdownConnectIcon} aria-hidden="true">
              <HugeiconsIcon icon={Wallet02Icon} size={14} strokeWidth={1.75} />
            </span>
            <span className={styles.creditsDropdownConnectText}>
              <span className={styles.creditsDropdownConnectTitle}>Connect a wallet</span>
              <span className={styles.creditsDropdownConnectSubtitle}>
                Link an address to deposit USDC
              </span>
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
          onClick={handleManage}
          type="button"
        >
          Manage
        </button>
        <button
          className={styles.creditsDropdownAddBtn}
          onClick={handleDeposit}
          type="button"
        >
          Deposit
        </button>
      </div>
    </>
  );
}
