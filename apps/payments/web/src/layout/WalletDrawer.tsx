import { useEffect, useState, useCallback } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { BalanceData, PaymentConfig } from '../types';
import { useSetOperator } from '../hooks/useSetOperator';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { Button } from '../components/Button';

interface WalletDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  balance: BalanceData | null;
  config: PaymentConfig | null;
  buyerEvmAddress: string | null;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 10.5V3.5C3 2.67 3.67 2 4.5 2H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function useCopyable() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
    } catch {
      // clipboard blocked — ignore
    }
  }, []);
  return { copied, copy };
}

export function WalletDrawer({
  isOpen,
  onClose,
  balance,
  config,
  buyerEvmAddress,
  onOpenDeposit,
  onOpenWithdraw,
}: WalletDrawerProps) {
  const { address: connectedAddress, isConnected, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { copied, copy } = useCopyable();

  const { operator: onChainOperator, operatorSet, refetch: refetchOperator } = useAuthorizedWallet();
  const operatorLoading = operatorSet === null;

  const setOperator = useSetOperator(config, refetchOperator);

  useEffect(() => {
    if (isOpen) void refetchOperator();
  }, [isOpen, refetchOperator]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const hasOperator = Boolean(
    onChainOperator && onChainOperator.toLowerCase() !== ZERO_ADDR,
  );
  const operatorMatchesConnected = Boolean(
    hasOperator &&
      connectedAddress &&
      onChainOperator &&
      onChainOperator.toLowerCase() === connectedAddress.toLowerCase(),
  );

  const available = balance ? parseFloat(balance.available) : 0;
  const reserved = balance ? parseFloat(balance.reserved) : 0;
  const total = balance ? parseFloat(balance.total) : 0;

  function handleDepositMore() {
    onOpenDeposit();
  }

  function handleWithdraw() {
    onOpenWithdraw();
  }

  return (
    <>
      <div
        className={`wallet-drawer-backdrop${isOpen ? ' wallet-drawer-backdrop--open' : ''}`}
        onClick={onClose}
        aria-hidden={!isOpen}
      />
      <aside
        className={`wallet-drawer${isOpen ? ' wallet-drawer--open' : ''}`}
        role="dialog"
        aria-label="Wallet"
        aria-hidden={!isOpen}
      >
        <header className="wallet-drawer-header">
          <div className="wallet-drawer-header-titles">
            <div className="wallet-drawer-eyebrow">Wallet</div>
            <div className="wallet-drawer-title">Accounts &amp; balances</div>
          </div>
          <button
            type="button"
            className="wallet-drawer-close"
            onClick={onClose}
            aria-label="Close wallet"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="wallet-drawer-body">
          {/* ── AntSeed account ───────────────────────────────── */}
          <section className="wallet-drawer-section">
            <div className="wallet-drawer-section-label">Your AntSeed account</div>
            <div className="wallet-drawer-card">
              <div className="wallet-drawer-card-row">
                <div className="wallet-drawer-role">
                  <span className="wallet-drawer-role-dot wallet-drawer-role-dot--signer" />
                  Signer
                </div>
                <button
                  type="button"
                  className={`wallet-drawer-addr${copied === 'buyer' ? ' wallet-drawer-addr--copied' : ''}`}
                  onClick={() => buyerEvmAddress && copy(buyerEvmAddress, 'buyer')}
                  disabled={!buyerEvmAddress}
                  title={buyerEvmAddress ?? ''}
                >
                  <span className="wallet-drawer-addr-value">
                    {buyerEvmAddress ? truncate(buyerEvmAddress) : '—'}
                  </span>
                  <span className="wallet-drawer-addr-icon">
                    {copied === 'buyer' ? <CheckIcon /> : <CopyIcon />}
                  </span>
                </button>
              </div>
              <p className="wallet-drawer-explainer">
                Your signer authorizes spending from your AntSeed account — it never
                holds USDC itself. The balance lives in the AntseedDeposits contract,
                tracked under this address. Your signer never needs gas.
              </p>
            </div>

            <div className="wallet-drawer-balances">
              <div className="wallet-drawer-balance">
                <span className="wallet-drawer-balance-label">Available</span>
                <span className="wallet-drawer-balance-value">${formatUsd(available)}</span>
              </div>
              <div className="wallet-drawer-balance">
                <span className="wallet-drawer-balance-label">Reserved</span>
                <span className="wallet-drawer-balance-value">${formatUsd(reserved)}</span>
              </div>
              <div className="wallet-drawer-balance">
                <span className="wallet-drawer-balance-label">Total</span>
                <span className="wallet-drawer-balance-value">${formatUsd(total)}</span>
              </div>
            </div>

            <div className="wallet-drawer-actions">
              <Button variant="primary" onClick={handleDepositMore}>
                Deposit more
              </Button>
              <Button variant="outline" onClick={handleWithdraw}>
                Withdraw
              </Button>
            </div>
          </section>

          {/* ── Your wallet ───────────────────────────────────── */}
          <section className="wallet-drawer-section">
            <div className="wallet-drawer-section-label">Your wallet</div>

            {!isConnected ? (
              <div className="wallet-drawer-card">
                <div className="wallet-drawer-role">
                  <span className="wallet-drawer-role-dot wallet-drawer-role-dot--operator" />
                  Wallet
                </div>
                <p className="wallet-drawer-explainer">
                  Connect a wallet to receive withdrawals, claim ANTS rewards, and
                  submit on-chain actions for your account. Deposits from any wallet
                  fund your AntSeed account above.
                </p>
                <div className="wallet-drawer-connect-wrap">
                  <ConnectButton
                    chainStatus="icon"
                    accountStatus="full"
                    showBalance={false}
                  />
                </div>
              </div>
            ) : (
              <div className="wallet-drawer-card">
                <div className="wallet-drawer-card-row">
                  <div className="wallet-drawer-role">
                    <span className="wallet-drawer-role-dot wallet-drawer-role-dot--operator" />
                    Connected
                  </div>
                  <button
                    type="button"
                    className={`wallet-drawer-addr${copied === 'operator' ? ' wallet-drawer-addr--copied' : ''}`}
                    onClick={() => connectedAddress && copy(connectedAddress, 'operator')}
                    title={connectedAddress ?? ''}
                  >
                    <span className="wallet-drawer-addr-value">
                      {connectedAddress ? truncate(connectedAddress) : '—'}
                    </span>
                    <span className="wallet-drawer-addr-icon">
                      {copied === 'operator' ? <CheckIcon /> : <CopyIcon />}
                    </span>
                  </button>
                </div>

                <div className="wallet-drawer-meta">
                  <span className="wallet-drawer-meta-label">Provider</span>
                  <span className="wallet-drawer-meta-value">{connector?.name ?? 'Unknown'}</span>
                </div>

                <div className="wallet-drawer-operator-status">
                  {operatorLoading ? (
                    <span className="wallet-drawer-pill wallet-drawer-pill--muted">
                      Checking authorization…
                    </span>
                  ) : operatorMatchesConnected ? (
                    <span className="wallet-drawer-pill wallet-drawer-pill--ok">
                      <CheckIcon /> Authorized for withdrawals
                    </span>
                  ) : hasOperator ? (
                    <div className="wallet-drawer-warn">
                      <div className="wallet-drawer-warn-title">Another wallet is authorized</div>
                      <div className="wallet-drawer-warn-desc">
                        Currently authorized: <strong>{onChainOperator ? truncate(onChainOperator) : ''}</strong>.
                        Replace it with this wallet to withdraw, claim ANTS, and close channels from here.
                      </div>
                    </div>
                  ) : (
                    <div className="wallet-drawer-warn">
                      <div className="wallet-drawer-warn-title">No authorized wallet yet</div>
                      <div className="wallet-drawer-warn-desc">
                        Without an authorized wallet you cannot withdraw USDC, claim ANTS,
                        or close channels. If you lose access to this node, your funds
                        become unrecoverable. Authorize this wallet to keep your funds safe.
                      </div>
                    </div>
                  )}
                </div>

                {!operatorMatchesConnected && (
                  <Button
                    variant="primary"
                    onClick={() => void setOperator.run()}
                    disabled={setOperator.running || !config}
                  >
                    {setOperator.running
                      ? 'Authorizing…'
                      : hasOperator
                        ? 'Replace authorized wallet'
                        : 'Authorize this wallet'}
                  </Button>
                )}

                {setOperator.error && (
                  <div className="wallet-drawer-error">{setOperator.error}</div>
                )}

                <button
                  type="button"
                  className="wallet-drawer-link"
                  onClick={() => disconnect()}
                >
                  Disconnect
                </button>
              </div>
            )}

            <p className="wallet-drawer-footnote">
              Deposits can come from any wallet and fund your AntSeed account.
              Withdrawals are sent to the wallet you authorize here.
            </p>
          </section>
        </div>
      </aside>
    </>
  );
}
