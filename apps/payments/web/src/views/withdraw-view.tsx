import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { HugeiconsIcon } from '@hugeicons/react';
import { Wallet02Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { useAuthorizedWallet } from '../context/authorized-wallet-context';
import { useBalance, useConfig } from '../hooks/queries';
import { useWithdraw } from '../hooks/use-withdraw';
import { useAppShell } from '../context/app-shell-context';
import { usePaymentNetwork } from '../lib/payment-network';
import { UsdcLogo, BaseLogo } from '../components/ui/brand-logos';
import { formatUsd, formatAmountInput, truncateAddr, ZERO_ADDR } from '../lib/format';
import './withdraw-view.scss';

export function WithdrawView() {
  const { data: config = null } = useConfig();
  const { data: balance = null } = useBalance();
  const { refreshBalance: onAction } = useAppShell();
  const [amount, setAmount] = useState('');
  const { address, isConnected } = useAccount();
  const { requireAuthorization, operator } = useAuthorizedWallet();
  const { targetChainName, walletChainId, wrongChain, isSwitchingChain } = usePaymentNetwork(config);

  const { run, running, success, error, reset, txHash } = useWithdraw(config, () => {
    onAction();
  });

  if (!balance) {
    return (
      <div className="withdraw">
        <div className="card">
          <div className="card-section-title">Withdraw USDC</div>
          <div className="rh-form">
            <div className="rh-explainer">Loading your balance…</div>
          </div>
        </div>
      </div>
    );
  }

  const availableAmount = parseFloat(balance.available);
  const buyer = config?.evmAddress ?? balance.evmAddress;

  const operatorSet = !!operator && operator !== ZERO_ADDR;
  const wrongWallet = Boolean(
    isConnected && operatorSet && address && address.toLowerCase() !== operator!.toLowerCase(),
  );

  const amountNum = amount ? parseFloat(amount) : 0;
  const validAmount = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= availableAmount;
  const overAvailable = Number.isFinite(amountNum) && amountNum > availableAmount;

  function handleClick() {
    if (!buyer) return;
    requireAuthorization(async () => {
      reset();
      await run(buyer, amount);
    });
  }

  function resetForm() {
    setAmount('');
    reset();
  }

  // Quick chip presets — percentages of available, plus Max
  const chipFractions: Array<{ label: string; value: number }> = [
    { label: '25%', value: availableAmount * 0.25 },
    { label: '50%', value: availableAmount * 0.5 },
    { label: '75%', value: availableAmount * 0.75 },
  ].filter((c) => c.value > 0);

  const ctaLabel = isSwitchingChain ? `Switching to ${targetChainName}…` :
    wrongChain ? `Switch to ${targetChainName}` :
    running ? 'Processing…' :
    'Withdraw';

  return (
    <div className="withdraw">
      <div className="card">
        <div className="card-section-title">Withdraw USDC</div>
        <div className="wallet-role-hint">
          Withdrawals are sent to your authorized wallet. You'll be prompted to authorize one if you haven't already.
        </div>

        <div className="rh-form">
          {success ? (
            <div className="rh-success">
              <div className="rh-success-burst" aria-hidden="true">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12.5L10 17.5L19 6.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="rh-success-amount">
                <span className="rh-hero-symbol">$</span>
                {amount || '0'}
                <span className="rh-success-unit">USDC</span>
              </div>
              <div className="rh-success-title">Withdrawal sent</div>
              {txHash && (
                <div className="rh-success-hash">{txHash.slice(0, 10)}…{txHash.slice(-6)}</div>
              )}
              {operator && operatorSet && (
                <div className="rh-success-note">
                  Sent to {truncateAddr(operator)}
                </div>
              )}
              <div className="rh-success-note">
                Funds are on their way. Return to AntSeed Desktop to keep going.
              </div>
              <button type="button" className="rh-cta rh-cta--ghost" onClick={resetForm}>
                Withdraw more
              </button>
            </div>
          ) : !isConnected ? (
            <>
              <div className="rh-hero">
                <div className="rh-hero-cap">
                  <span className="rh-hero-label">You're withdrawing</span>
                </div>
                <div className="rh-hero-amount" aria-hidden="true">
                  <span className="rh-hero-symbol">$</span>
                  <span className="rh-hero-input rh-hero-input--placeholder">0</span>
                </div>
                <div className="rh-hero-currency">USDC · connect wallet to begin</div>
              </div>

              <div className="rh-explainer">
                Connect a wallet so AntSeed can send funds to your authorized destination.
              </div>

              <ConnectButton.Custom>
                {({ openConnectModal, mounted }) => (
                  <button
                    type="button"
                    className="rh-cta"
                    onClick={openConnectModal}
                    disabled={!mounted}
                  >
                    <span>Connect wallet</span>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
                  </button>
                )}
              </ConnectButton.Custom>
            </>
          ) : (
            <>
              {/* Connected wallet card */}
              {address && (
                <div className="rh-wallet-card" role="status" aria-label={`Wallet ${truncateAddr(address)} connected on ${targetChainName}`}>
                  <span className="rh-wallet-card-icon" aria-hidden="true">
                    <HugeiconsIcon icon={Wallet02Icon} size={18} strokeWidth={1.6} />
                  </span>
                  <div className="rh-wallet-card-text">
                    <span className="rh-wallet-card-label">Connected wallet</span>
                    <span className="rh-wallet-card-addr">{truncateAddr(address)}</span>
                  </div>
                  <span className="rh-wallet-card-status">
                    <span className="rh-wallet-card-network">
                      Connected to
                      <span className="rh-wallet-card-network-logo" aria-hidden="true">
                        <BaseLogo size={12} />
                      </span>
                      {targetChainName}
                    </span>
                  </span>
                </div>
              )}

              {wrongChain && (
                <div className="rh-banner rh-banner--warn" role="alert">
                  Wallet is on chain {walletChainId ?? 'unknown'}. Switch to {targetChainName} before withdrawing.
                </div>
              )}

              {wrongWallet && operator && (
                <div className="rh-banner rh-banner--error" role="alert">
                  This account is authorized to <strong>{truncateAddr(operator)}</strong>. Connect that wallet to withdraw, or transfer authorization first.
                </div>
              )}

              {/* Hero amount */}
              <div className="rh-hero">
                <div className="rh-hero-cap">
                  <span className="rh-hero-label">You're withdrawing</span>
                  {availableAmount > 0 && (
                    <button
                      type="button"
                      className="rh-hero-max"
                      onClick={() => setAmount(formatAmountInput(availableAmount))}
                      disabled={running}
                    >
                      Max ${formatUsd(availableAmount)}
                    </button>
                  )}
                </div>
                <label className="rh-hero-amount" aria-label="Withdraw amount in USDC">
                  <span className="rh-hero-symbol">$</span>
                  <input
                    className="rh-hero-input"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="0"
                    value={amount}
                    onChange={(e) => {
                      const next = e.target.value.replace(/[^0-9.]/g, '');
                      setAmount(next);
                    }}
                    disabled={running}
                    aria-invalid={overAvailable}
                  />
                </label>
                <div className="rh-hero-currency">
                  <span className="rh-coin"><UsdcLogo size={14} /></span>
                  USDC
                  <span className="rh-currency-sep" aria-hidden="true">·</span>
                  <span className="rh-coin"><BaseLogo size={14} /></span>
                  {targetChainName}
                </div>
              </div>

              {/* Quick chips */}
              {chipFractions.length > 0 && (
                <div className="rh-chips" role="group" aria-label="Quick amount presets">
                  {chipFractions.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      className="rh-chip"
                      onClick={() => setAmount(formatAmountInput(c.value))}
                      disabled={running}
                    >
                      {c.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`rh-chip rh-chip--max ${amount === formatAmountInput(availableAmount) ? 'is-active' : ''}`}
                    onClick={() => setAmount(formatAmountInput(availableAmount))}
                    disabled={running}
                  >
                    Max
                  </button>
                </div>
              )}

              {/* Meta line */}
              <div className="rh-meta">
                <span className="rh-meta-line">
                  <span className="rh-meta-key">Available</span>
                  <span className="rh-meta-val">${formatUsd(availableAmount)}</span>
                </span>
                <span className="rh-meta-dot" aria-hidden="true" />
                <span className="rh-meta-line">
                  <span className="rh-meta-key">Destination</span>
                  <span className="rh-meta-val">{operatorSet && operator ? truncateAddr(operator) : 'authorized wallet'}</span>
                </span>
              </div>

              {overAvailable && (
                <div className="rh-banner rh-banner--error" role="alert">
                  You can withdraw at most ${formatUsd(availableAmount)} USDC.
                </div>
              )}

              <button
                className="rh-cta"
                onClick={handleClick}
                disabled={
                  running ||
                  isSwitchingChain ||
                  !validAmount ||
                  !buyer ||
                  wrongWallet ||
                  !config
                }
              >
                <span>{ctaLabel}</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
              </button>
            </>
          )}

          {error && <div className="rh-banner rh-banner--error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
