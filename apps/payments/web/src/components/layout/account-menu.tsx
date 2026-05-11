import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useDisconnect } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Wallet01Icon,
  Wallet02Icon,
  WalletAdd01Icon,
  WalletRemove01Icon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  Tick02Icon,
  Sun02Icon,
  Moon02Icon,
  Alert02Icon,
  ExchangeIcon,
  UserCircleIcon,
  Logout02Icon,
  BookOpen01Icon,
} from '@hugeicons/core-free-icons';
import { usePaymentNetwork } from '../../lib/payment-network';
import { useAuthorizedWallet } from '../../context/authorized-wallet-context';
import { useBalance, useConfig, useBuyerEvmAddress } from '../../hooks/queries';
import { useSetOperator, useTransferOperator } from '../../hooks/use-set-operator';
import { useAppShell } from '../../context/app-shell-context';
import { InfoHint } from '../ui/info-hint';
import { Tooltip } from '../ui/tooltip';
import { BaseLogo } from '../ui/brand-logos';
import { formatUsd, truncateAddr, ZERO_ADDR } from '../../lib/format';

function splitUsd(n: number | null): { whole: string; cents: string } {
  if (n === null || !Number.isFinite(n)) return { whole: '—', cents: '' };
  const [whole, cents = '00'] = formatUsd(n).split('.');
  return { whole, cents };
}

export function SidebarAuthWarning() {
  const { operatorSet, requireAuthorization } = useAuthorizedWallet();
  if (operatorSet !== false) return null;

  return (
    <button
      type="button"
      className="dash-auth-warning"
      onClick={() => requireAuthorization()}
    >
      <span className="dash-auth-warning-icon">
        <HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={1.6} />
      </span>
      <span className="dash-auth-warning-text">
        <span className="dash-auth-warning-title">Wallet not authorized</span>
        <span className="dash-auth-warning-sub">Click to authorize</span>
      </span>
    </button>
  );
}

export function AccountMenu() {
  const { data: config = null } = useConfig();
  const { data: balance = null } = useBalance();
  const buyerEvmAddress = useBuyerEvmAddress();
  const { isDark, toggleTheme, openDeposit, openWithdraw } = useAppShell();
  const [open, setOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<'signer' | 'wallet' | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferAddr, setTransferAddr] = useState('');
  const [authExpanded, setAuthExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const { address: connectedAddress, isConnected, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const {
    wrongChain,
    isSwitchingChain,
    targetChainName,
    ensureCorrectNetwork,
  } = usePaymentNetwork(config);

  const { operator: onChainOperator, operatorSet, refetch: refetchOperator } = useAuthorizedWallet();
  const operatorLoading = operatorSet === null;
  const setOperator = useSetOperator(config, refetchOperator);
  const transferOperator = useTransferOperator(config, () => {
    void refetchOperator();
    setShowTransfer(false);
    setTransferAddr('');
  });
  const { reset: resetTransferOperator } = transferOperator;

  const hasOperator = Boolean(
    onChainOperator && onChainOperator.toLowerCase() !== ZERO_ADDR,
  );
  const operatorMatchesConnected = Boolean(
    hasOperator &&
      connectedAddress &&
      onChainOperator &&
      onChainOperator.toLowerCase() === connectedAddress.toLowerCase(),
  );

  useEffect(() => {
    if (open) void refetchOperator();
  }, [open, refetchOperator]);

  useEffect(() => {
    if (!open) {
      setShowTransfer(false);
      setTransferAddr('');
      setAuthExpanded(false);
      resetTransferOperator();
    }
  }, [open, resetTransferOperator]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Anchor the portaled popover to the trigger button's screen position.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setPopoverStyle({
        position: 'fixed',
        left: rect.left,
        bottom: window.innerHeight - rect.top + 10,
      });
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const handleCopy = useCallback(async (value: string, key: 'signer' | 'wallet') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1400);
    } catch {
      // clipboard blocked — ignore
    }
  }, []);

  const handleSwitchChain = useCallback(async () => {
    setSwitchError(null);
    try {
      await ensureCorrectNetwork();
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : 'Switch failed';
      setSwitchError(message);
      window.setTimeout(() => setSwitchError(null), 4000);
    }
  }, [ensureCorrectNetwork]);

  const total = balance ? parseFloat(balance.total) : null;
  const available = balance ? parseFloat(balance.available) : null;
  const reserved = balance ? parseFloat(balance.reserved) : 0;
  const totalParts = splitUsd(total);
  const availableParts = splitUsd(available);

  const previewBalance = total !== null ? `$${formatUsd(total)}` : '—';
  const previewSubtitle = isConnected && connectedAddress
    ? truncateAddr(connectedAddress)
    : 'Not connected';

  const popover = open ? (
    <div
      className="dash-account-popover"
      role="dialog"
      aria-label="AntSeed account"
      ref={popoverRef}
      style={popoverStyle}
    >
          <div className="dash-account-hero">
            <div className="dash-account-hero-eyebrow">USDC available</div>
            <div className="dash-account-hero-amount">
              <span className="dash-account-hero-currency">$</span>
              <span className="dash-account-hero-whole">{availableParts.whole}</span>
              <span className="dash-account-hero-cents">.{availableParts.cents || '00'}</span>
            </div>
            <div className="dash-account-hero-meta">
              <span>
                Total <span className="dash-account-hero-meta-value">${totalParts.whole}.{totalParts.cents || '00'}</span>
              </span>
              <span className="dash-account-hero-meta-dot" aria-hidden="true" />
              <span className="dash-account-hero-meta-reserved">
                Reserved <span className="dash-account-hero-meta-value">${formatUsd(reserved)}</span>
                <InfoHint>
                  <p>
                    USDC <strong>locked in open payment channels</strong> with sellers.
                    You can't spend reserved funds on other things until the channel
                    closes.
                  </p>
                  <p>
                    When a channel closes, any unspent reserved amount returns to your
                    available balance.
                  </p>
                </InfoHint>
              </span>
            </div>
          </div>

          <div className="dash-account-divider" aria-hidden="true" />

          <div className="dash-account-section">
            <div className="dash-account-section-label-row">
              <span className="dash-account-section-label">Signer</span>
              <InfoHint>
                <p>
                  Your <strong>AntSeed account</strong>. USDC is held here and used to
                  authorize spending on the network.
                </p>
                <p>
                  Anyone can deposit into this account; only your authorized wallet can
                  withdraw from it.
                </p>
              </InfoHint>
            </div>
            {buyerEvmAddress ? (
              <button
                type="button"
                className={`dash-account-addr${copiedKey === 'signer' ? ' dash-account-addr--copied' : ''}`}
                onClick={() => handleCopy(buyerEvmAddress, 'signer')}
                title={copiedKey === 'signer' ? 'Copied' : 'Copy signer address'}
                aria-label={copiedKey === 'signer' ? 'Signer address copied' : 'Copy signer address'}
              >
                <span className="dash-account-addr-icon-leading">
                  <HugeiconsIcon icon={UserCircleIcon} size={14} strokeWidth={1.5} />
                </span>
                <span className="dash-account-addr-value">{truncateAddr(buyerEvmAddress)}</span>
                <span className="dash-account-addr-icon">
                  <HugeiconsIcon icon={copiedKey === 'signer' ? Tick02Icon : Copy01Icon} size={12} strokeWidth={1.8} />
                </span>
              </button>
            ) : (
              <div className="dash-account-addr dash-account-addr--empty">
                No signer address
              </div>
            )}
          </div>

          <div className="dash-account-section">
            <div className="dash-account-section-label-row">
              <span className="dash-account-section-label">Connected wallet</span>
              <InfoHint>
                <p>
                  Your <strong>connected wallet</strong> (MetaMask, Coinbase Wallet, etc.).
                </p>
                <p>
                  Used to sign on-chain transactions like deposits, withdrawals, and ANTS
                  claims. Authorize it once to enable withdrawals from your signer.
                </p>
              </InfoHint>
            </div>
            {connectedAddress ? (
              <>
                <button
                  type="button"
                  className={`dash-account-addr${copiedKey === 'wallet' ? ' dash-account-addr--copied' : ''}`}
                  onClick={() => handleCopy(connectedAddress, 'wallet')}
                  title={copiedKey === 'wallet' ? 'Copied' : 'Copy wallet address'}
                  aria-label={copiedKey === 'wallet' ? 'Wallet address copied' : 'Copy wallet address'}
                >
                  <span className="dash-account-addr-icon-leading">
                    <HugeiconsIcon icon={Wallet02Icon} size={14} strokeWidth={1.5} />
                  </span>
                  <span className="dash-account-addr-value">{truncateAddr(connectedAddress)}</span>
                  {connector?.name && (
                    <span className="dash-account-addr-provider">{connector.name}</span>
                  )}
                  <span className="dash-account-addr-icon">
                    <HugeiconsIcon icon={copiedKey === 'wallet' ? Tick02Icon : Copy01Icon} size={12} strokeWidth={1.8} />
                  </span>
                </button>

                {!operatorLoading && operatorMatchesConnected && !showTransfer && (
                  <div
                    className={`dash-account-auth-card${authExpanded ? ' dash-account-auth-card--expanded' : ''}`}
                  >
                    <button
                      type="button"
                      className="dash-account-auth-card-header"
                      onClick={() => setAuthExpanded((v) => !v)}
                      aria-expanded={authExpanded}
                      aria-controls="dash-auth-card-panel"
                    >
                      <span className="dash-account-auth-card-pulse" aria-hidden="true">
                        <span className="dash-account-auth-card-pulse-dot" />
                        <span className="dash-account-auth-card-pulse-ring" />
                      </span>
                      <span className="dash-account-auth-card-label">Authorized for withdrawals</span>
                      <span
                        className="dash-account-auth-card-info"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InfoHint>
                          <p>
                            This wallet is <strong>authorized on-chain</strong> to withdraw USDC from
                            your AntSeed signer account.
                          </p>
                          <p>
                            Only one wallet can hold authorization at a time. Transfer it to a different
                            wallet, or disconnect from this site without touching the on-chain
                            authorization.
                          </p>
                        </InfoHint>
                      </span>
                      <span className="dash-account-auth-card-chevron" aria-hidden="true">
                        <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.8} />
                      </span>
                    </button>
                    <div
                      className="dash-account-auth-card-panel"
                      id="dash-auth-card-panel"
                      role="region"
                      aria-label="Authorization actions"
                      aria-hidden={!authExpanded}
                    >
                      <div className="dash-account-auth-card-panel-inner">
                        <div className="dash-account-auth-card-actions">
                          <Tooltip
                            title="Transfer authorization"
                            text="Move on-chain authorization to a different wallet. Useful when switching to a new wallet without losing access to your AntSeed account."
                            maxWidth={220}
                            wrapClassName="dash-hover-tip-trigger"
                            cardClassName="dash-hover-tip"
                            titleClassName="dash-hover-tip-title"
                            bodyClassName="dash-hover-tip-desc"
                          >
                            <button
                              type="button"
                              className="dash-account-auth-card-action"
                              onClick={() => setShowTransfer(true)}
                              tabIndex={authExpanded ? 0 : -1}
                            >
                              <HugeiconsIcon icon={ExchangeIcon} size={11} strokeWidth={1.8} />
                              <span>Transfer</span>
                            </button>
                          </Tooltip>
                          <Tooltip
                            title="Disconnect wallet"
                            text="Disconnect this wallet from the site. Your on-chain authorization stays in place — reconnecting this wallet later restores access."
                            maxWidth={220}
                            wrapClassName="dash-hover-tip-trigger"
                            cardClassName="dash-hover-tip"
                            titleClassName="dash-hover-tip-title"
                            bodyClassName="dash-hover-tip-desc"
                          >
                            <button
                              type="button"
                              className="dash-account-auth-card-action dash-account-auth-card-action--muted"
                              onClick={() => disconnect()}
                              tabIndex={authExpanded ? 0 : -1}
                            >
                              <HugeiconsIcon icon={Logout02Icon} size={11} strokeWidth={1.8} />
                              <span>Disconnect</span>
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!operatorLoading && hasOperator && !operatorMatchesConnected && (
                  <div className="dash-account-auth-warn">
                    <div className="dash-account-auth-warn-title">Wrong wallet connected</div>
                    <div className="dash-account-auth-warn-desc">
                      Switch to <strong>{onChainOperator ? truncateAddr(onChainOperator) : ''}</strong> to
                      withdraw, claim ANTS, and close channels.
                    </div>
                    <button
                      type="button"
                      className="dash-account-disconnect dash-account-disconnect--in-warn"
                      onClick={() => disconnect()}
                    >
                      <HugeiconsIcon icon={Logout02Icon} size={12} strokeWidth={1.8} />
                      Disconnect wallet
                    </button>
                  </div>
                )}

                {!operatorLoading && !hasOperator && (
                  <button
                    type="button"
                    className="dash-account-auth-cta"
                    onClick={() => void setOperator.run()}
                    disabled={setOperator.running || !config}
                  >
                    <HugeiconsIcon icon={Alert02Icon} size={12} strokeWidth={1.8} />
                    {setOperator.running ? 'Authorizing…' : 'Authorize this wallet'}
                  </button>
                )}

                {setOperator.error && (
                  <div className="dash-account-inline-error">{setOperator.error}</div>
                )}

                {operatorMatchesConnected && showTransfer && (
                  <div className="dash-account-transfer">
                    <label className="dash-account-section-label" htmlFor="dash-transfer-input">
                      Transfer to
                    </label>
                    <input
                      id="dash-transfer-input"
                      className="dash-account-input"
                      type="text"
                      placeholder="0x…"
                      value={transferAddr}
                      onChange={(e) => setTransferAddr(e.target.value)}
                      disabled={transferOperator.running}
                      autoFocus
                    />
                    <div className="dash-account-transfer-actions">
                      <button
                        type="button"
                        className="dash-account-action dash-account-action--primary"
                        onClick={() => buyerEvmAddress && void transferOperator.run(buyerEvmAddress, transferAddr)}
                        disabled={transferOperator.running || !transferAddr || !buyerEvmAddress}
                      >
                        {transferOperator.running ? 'Transferring…' : 'Transfer'}
                      </button>
                      <button
                        type="button"
                        className="dash-account-action"
                        onClick={() => { setShowTransfer(false); setTransferAddr(''); transferOperator.reset(); }}
                        disabled={transferOperator.running}
                      >
                        Cancel
                      </button>
                    </div>
                    {transferOperator.error && (
                      <div className="dash-account-inline-error">{transferOperator.error}</div>
                    )}
                  </div>
                )}

                {!operatorLoading && !hasOperator && !showTransfer && (
                  <button
                    type="button"
                    className="dash-account-disconnect"
                    onClick={() => disconnect()}
                  >
                    <HugeiconsIcon icon={Logout02Icon} size={12} strokeWidth={1.8} />
                    Disconnect wallet
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="dash-account-addr dash-account-addr--connect"
                onClick={() => { close(); openConnectModal?.(); }}
              >
                <span className="dash-account-addr-icon-leading">
                  <HugeiconsIcon icon={Wallet01Icon} size={14} strokeWidth={1.6} />
                </span>
                <span className="dash-account-addr-value">Connect wallet</span>
                <span className="dash-account-addr-icon">
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.8} />
                </span>
              </button>
            )}
          </div>

          <div className="dash-account-actions">
            <button
              type="button"
              className="dash-account-action dash-account-action--primary"
              onClick={() => { close(); openDeposit(); }}
            >
              <HugeiconsIcon icon={WalletAdd01Icon} size={14} strokeWidth={1.6} />
              Deposit
            </button>
            <button
              type="button"
              className="dash-account-action"
              onClick={() => { close(); openWithdraw(); }}
            >
              <HugeiconsIcon icon={WalletRemove01Icon} size={14} strokeWidth={1.6} />
              Withdraw
            </button>
          </div>

          <p className="dash-account-footnote">
            Deposits can come from any wallet and fund your AntSeed account.
            Withdrawals are sent to the wallet you authorize here.
          </p>

          <div className="dash-account-divider" aria-hidden="true" />

          <div className="dash-account-footer">
            <div className="dash-account-network">
              <span className="dash-account-network-logo">
                <BaseLogo size={12} />
              </span>
              <span className="dash-account-network-name">{targetChainName}</span>
              {wrongChain ? (
                <button
                  type="button"
                  className="dash-account-network-switch"
                  onClick={handleSwitchChain}
                  disabled={isSwitchingChain}
                  title={switchError ?? `Switch wallet to ${targetChainName}`}
                >
                  <HugeiconsIcon icon={ExchangeIcon} size={10} strokeWidth={1.8} />
                  {isSwitchingChain ? 'Switching…' : 'Switch'}
                </button>
              ) : (
                <span className="dash-account-network-dot" aria-hidden="true" />
              )}
            </div>

            <div className="dash-account-footer-tools">
              <a
                className="dash-account-icon-btn"
                href="https://antseed.com/docs/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open documentation"
                title="Documentation"
              >
                <HugeiconsIcon icon={BookOpen01Icon} size={14} strokeWidth={1.6} />
              </a>
              <button
                type="button"
                className="dash-account-icon-btn"
                onClick={toggleTheme}
                aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                <HugeiconsIcon icon={isDark ? Sun02Icon : Moon02Icon} size={14} strokeWidth={1.6} />
              </button>
            </div>
          </div>
    </div>
  ) : null;

  return (
    <div className="dash-account" ref={wrapRef}>
      {popover && createPortal(popover, document.body)}

      <button
        ref={triggerRef}
        type="button"
        className={`dash-account-trigger${open ? ' dash-account-trigger--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="AntSeed account menu"
        onClick={() => setOpen((p) => !p)}
      >
        <span className="dash-account-trigger-icon">
          <HugeiconsIcon icon={Wallet02Icon} size={15} strokeWidth={1.6} />
        </span>
        <span className="dash-account-trigger-text">
          <span className="dash-account-trigger-amount">{previewBalance}</span>
          <span className="dash-account-trigger-sub">{previewSubtitle}</span>
        </span>
        <span className="dash-account-trigger-chevron" aria-hidden="true">
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.8} />
        </span>
      </button>
    </div>
  );
}
