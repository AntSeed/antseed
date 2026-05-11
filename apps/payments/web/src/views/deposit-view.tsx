import { useState, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useChainId,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { BalanceData, PaymentConfig } from '../types';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { UsdcLogo, BaseLogo } from '../components/ui/brand-logos';
import { formatUsd, formatAmountInput, truncateAddr } from '../utils/format';
import { DEPOSITS_ABI, ERC20_ABI } from '../abi';
import './deposit-view.scss';

const MIN_FIRST_DEPOSIT = 1; // USDC — matches AntseedDeposits.MIN_BUYER_DEPOSIT

function parseUsd(value?: string | null): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeParseUsdc(value: string): bigint {
  try {
    return parseUnits(value || '0', 6);
  } catch {
    return 0n;
  }
}

function getSuggestedDeposit(maxDeposit: number, isFirstDeposit: boolean): string {
  const floor = isFirstDeposit ? MIN_FIRST_DEPOSIT : 0;
  if (maxDeposit <= 0 || maxDeposit < floor) return '';
  return formatAmountInput(Math.max(floor, Math.min(10, maxDeposit)));
}

interface DepositViewProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerAddress: string | null;
  onDeposited: () => void;
}

type DepositMethod = 'crypto' | 'card';

export function DepositView({ config, balance, buyerAddress, onDeposited }: DepositViewProps) {
  const [method, setMethod] = useState<DepositMethod>('crypto');

  return (
    <div className="deposit">
      <div className="card">
        <div className="card-section-title">Deposit USDC</div>
        <div className="wallet-role-hint">
          Any wallet can fund your AntSeed account. Your signer authorizes spending; the contract holds the balance.
        </div>

        <div className="rh-tabs" role="tablist" aria-label="Deposit method">
          <button
            role="tab"
            aria-selected={method === 'crypto'}
            className={`rh-tab ${method === 'crypto' ? 'is-active' : ''}`}
            onClick={() => setMethod('crypto')}
          >
            <span className="rh-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 4.5V11.5L8 15L15 11.5V4.5L8 1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M1 4.5L8 8M8 8L15 4.5M8 8V15" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
            </span>
            Crypto wallet
          </button>
          <button
            role="tab"
            aria-selected={method === 'card'}
            className={`rh-tab ${method === 'card' ? 'is-active' : ''}`}
            onClick={() => setMethod('card')}
          >
            <span className="rh-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/><line x1="1" y1="6.5" x2="15" y2="6.5" stroke="currentColor" strokeWidth="1.4"/></svg>
            </span>
            Credit card
            <span className="rh-tab-tag">Soon</span>
          </button>
          <span className={`rh-tab-indicator ${method === 'card' ? 'is-right' : ''}`} aria-hidden="true" />
        </div>

        {method === 'crypto' ? (
          <CryptoDeposit
            config={config}
            balance={balance}
            buyerAddress={buyerAddress}
            onDeposited={onDeposited}
          />
        ) : (
          <CardDepositPlaceholder />
        )}
      </div>
    </div>
  );
}

/* ── Crypto Deposit (wagmi + RainbowKit) ── */

function CryptoDeposit({ config, balance, buyerAddress, onDeposited }: {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerAddress: string | null;
  onDeposited: () => void;
}) {
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'idle' | 'approving' | 'checking-allowance' | 'depositing' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [trustDetailsOpen, setTrustDetailsOpen] = useState(false);
  const [stepExplainerOpen, setStepExplainerOpen] = useState(false);
  const [customTarget, setCustomTarget] = useState('');
  const [customTargetEdited, setCustomTargetEdited] = useState(false);

  const currentAvailable = parseUsd(balance?.available);
  const currentReserved = parseUsd(balance?.reserved);
  const currentTotal = parseUsd(balance?.total);
  const creditLimit = parseUsd(balance?.creditLimit);
  const balanceKnown = balance !== null;
  const remainingCreditLimit = balanceKnown ? Math.max(0, creditLimit - currentTotal) : 0;
  const isFirstDeposit = currentTotal === 0;
  const minDeposit = isFirstDeposit ? MIN_FIRST_DEPOSIT : 0;

  const {
    expectedChainId,
    targetChainName,
    walletChainId,
    wrongChain,
    isSwitchingChain,
    ensureCorrectNetwork,
  } = usePaymentNetwork(config);
  const defaultTarget = buyerAddress ?? address;

  const {
    data: walletUsdcRaw,
    refetch: refetchWalletUsdc,
    isLoading: walletUsdcLoading,
    isFetching: walletUsdcFetching,
  } = useReadContract({
    address: config?.usdcContractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    chainId: expectedChainId,
    args: [address as `0x${string}`],
    query: { enabled: isConnected && !!config && !!address },
  });
  const walletUsdcBalance = walletUsdcRaw === undefined ? null : Number.parseFloat(formatUnits(walletUsdcRaw, 6));
  const walletUsdcKnown = walletUsdcBalance !== null && Number.isFinite(walletUsdcBalance);
  const maxDeposit = Math.max(0, Math.min(remainingCreditLimit, walletUsdcKnown ? walletUsdcBalance : remainingCreditLimit));
  const maxDepositReason = remainingCreditLimit <= 0
    ? 'limit'
    : walletUsdcKnown && walletUsdcBalance <= remainingCreditLimit
      ? 'wallet'
      : 'limit';

  // Default amount: suggest 10 USDC capped by both remaining headroom and wallet USDC.
  // Wait for BOTH the AntSeed balance and the on-chain wallet USDC read to settle —
  // suggesting on `balance` alone would pre-fill the credit-limit headroom before the
  // wallet read returns, and the guard below would then prevent any correction once
  // the wallet turns out to be $0. When the wallet read isn't enabled (no wallet
  // connected), walletUsdcRaw stays undefined forever, so don't wait on it then.
  const walletReadPending = isConnected && !!config && !!address && walletUsdcRaw === undefined;
  useEffect(() => {
    if (amount !== '' || !balance || walletReadPending) return;
    const suggested = getSuggestedDeposit(maxDeposit, isFirstDeposit);
    if (suggested) setAmount(suggested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance, walletUsdcRaw, walletReadPending]);

  const amountNum = amount ? Number.parseFloat(amount) : 0;
  let validationError: string | null = null;
  if (amount !== '' && balance) {
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      validationError = 'Enter a valid amount';
    } else if (!/^\d+(\.\d{0,6})?$/.test(amount.trim())) {
      validationError = 'USDC supports up to 6 decimal places';
    } else if (amountNum < minDeposit) {
      validationError = `Minimum first deposit is ${minDeposit} USDC`;
    } else if (!walletUsdcKnown) {
      validationError = 'Loading your connected wallet USDC balance…';
    } else if (amountNum > remainingCreditLimit) {
      validationError = remainingCreditLimit <= 0
        ? 'You have reached your credit limit'
        : `You already have $${formatUsd(currentTotal)} in AntSeed. You can add $${formatUsd(remainingCreditLimit)} more.`;
    } else if (walletUsdcKnown && amountNum > walletUsdcBalance) {
      validationError = `Your connected wallet only has ${formatUsd(walletUsdcBalance)} USDC available.`;
    }
  }
  const isValidAmount = amount !== '' && !validationError && amountNum > 0;


  // Pre-fill the override input with the signer/buyer address once available,
  // until the user manually edits it. This lets people see what the deposit
  // will credit to, and gives them a concrete address to replace. Falls back
  // to the connected wallet only when the buyer address isn't known yet.
  useEffect(() => {
    if (customTargetEdited) return;
    const next = buyerAddress ?? address;
    if (!next) return;
    setCustomTarget(next);
  }, [buyerAddress, address, customTargetEdited]);

  const customTargetTrimmed = customTarget.trim();
  const customTargetIsValid = /^0x[a-fA-F0-9]{40}$/.test(customTargetTrimmed);
  const customTargetInvalid = showAdvanced && customTargetTrimmed !== '' && !customTargetIsValid;
  const depositTarget =
    showAdvanced && customTargetIsValid
      ? (customTargetTrimmed as `0x${string}`)
      : defaultTarget;
  const isOverridingTarget =
    showAdvanced &&
    customTargetIsValid &&
    defaultTarget !== undefined &&
    customTargetTrimmed.toLowerCase() !== (defaultTarget as string).toLowerCase();

  // Read on-chain allowance (always, when connected)
  const {
    data: allowance,
    refetch: refetchAllowance,
    isLoading: allowanceLoading,
    isFetching: allowanceFetching,
  } = useReadContract({
    address: config?.usdcContractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    chainId: expectedChainId,
    args: [address as `0x${string}`, config?.depositsContractAddress as `0x${string}`],
    query: { enabled: isConnected && !!config && !!address },
  });

  const usdcAmount = safeParseUsdc(amount);
  const allowanceKnown = allowance !== undefined;
  const isCheckingAllowance = allowanceLoading || allowanceFetching || step === 'checking-allowance';
  const hasAllowance = allowanceKnown && allowance >= usdcAmount && usdcAmount > 0n;
  const allowanceShortfall = isValidAmount && allowanceKnown && allowance < usdcAmount;
  const currentWizardStep = !isValidAmount ? 1 : hasAllowance ? 2 : 1;

  // Approve USDC
  const {
    writeContract: writeApprove,
    data: approveTxHash,
    reset: resetApprove,
  } = useWriteContract();

  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    chainId: expectedChainId,
    query: { enabled: step === 'approving' && !!approveTxHash },
  });

  const {
    writeContract: writeDeposit,
    data: depositTxHash,
    reset: resetDeposit,
  } = useWriteContract();

  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
    chainId: expectedChainId,
    query: { enabled: step === 'depositing' && !!depositTxHash },
  });

  // After approval confirms → refetch allowance. Keep the user on an explicit
  // "checking" state instead of assuming approval immediately changed allowance.
  useEffect(() => {
    if (step !== 'approving' || !approveConfirmed) return;
    setStep('checking-allowance');
    void refetchAllowance();
  }, [step, approveConfirmed, refetchAllowance]);

  // Once allowance is confirmed on-chain, let the user start step 2 manually.
  useEffect(() => {
    if (step !== 'checking-allowance') return;
    if (hasAllowance) setStep('idle');
  }, [step, hasAllowance]);

  // After deposit confirms → done
  useEffect(() => {
    if (step === 'depositing' && depositConfirmed) {
      setStep('done');
      onDeposited();
    }
  }, [depositConfirmed, step, onDeposited]);

  async function handleDeposit() {
    if (!address || !isValidAmount || !config || !depositTarget) return;

    setError(null);

    try {
      await ensureCorrectNetwork();
    } catch (err) {
      setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      return;
    }

    resetApprove();
    resetDeposit();

    const walletResult = await refetchWalletUsdc();
    const latestWalletUsdc = walletResult.data === undefined ? null : Number.parseFloat(formatUnits(walletResult.data, 6));
    if (latestWalletUsdc === null || !Number.isFinite(latestWalletUsdc)) {
      setError('Could not check your wallet USDC balance. Please try again.');
      return;
    }
    if (amountNum > latestWalletUsdc) {
      setError(`Your connected wallet only has ${formatUsd(latestWalletUsdc)} USDC available.`);
      return;
    }

    const allowanceResult = await refetchAllowance();
    const latestAllowance = allowanceResult.data;
    if (latestAllowance === undefined) {
      setError('Could not check your USDC approval. Please try again.');
      return;
    }

    // Step 2: allowance is already sufficient — deposit directly.
    if (latestAllowance >= usdcAmount) {
      setStep('depositing');
      writeDeposit({
        address: config.depositsContractAddress as `0x${string}`,
        abi: DEPOSITS_ABI,
        functionName: 'deposit',
        chainId: expectedChainId,
        args: [depositTarget as `0x${string}`, usdcAmount],
      }, {
        onError: (err) => {
          setStep('idle');
          setError(getErrorMessage(err));
        },
      });
      return;
    }

    // Step 1: approve USDC first. The user will click again to deposit after
    // approval is confirmed and allowance has been rechecked.
    setStep('approving');
    writeApprove({
      address: config.usdcContractAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      chainId: expectedChainId,
      args: [config.depositsContractAddress as `0x${string}`, usdcAmount],
    }, {
      onError: (err) => {
        setStep('idle');
        setError(getErrorMessage(err));
      },
    });
  }

  function resetForm() {
    setStep('idle');
    setError(null);
    setAmount(getSuggestedDeposit(maxDeposit, isFirstDeposit));
    resetApprove();
    resetDeposit();
  }

  const ctaLabel = isSwitchingChain ? `Switching to ${targetChainName}…` :
    wrongChain ? `Switch to ${targetChainName}` :
    walletUsdcLoading || walletUsdcFetching || !walletUsdcKnown ? 'Loading wallet USDC…' :
    isCheckingAllowance ? 'Checking approval…' :
    step === 'approving' ? 'Approve in wallet…' :
    step === 'depositing' ? 'Depositing…' :
    allowanceShortfall ? `Approve ${amount || '0'} USDC` :
    'Review & deposit';

  // Quick chip presets — only show chips that respect the current ceiling.
  const chipValues = [10, 25, 50, 100].filter((v) => v <= maxDeposit || maxDeposit === 0);

  return (
    <div className="rh-form">
      {!isConnected ? (
        <>
          <div className="rh-hero" data-state="disconnected">
            <div className="rh-hero-cap">
              <span className="rh-hero-label">You're adding</span>
              <span className="rh-hero-max rh-hero-max--ghost">— —</span>
            </div>
            <div className="rh-hero-amount" aria-hidden="true">
              <span className="rh-hero-symbol">$</span>
              <span className="rh-hero-input rh-hero-input--placeholder">0</span>
            </div>
            <div className="rh-hero-currency">USDC · connect wallet to begin</div>
          </div>

          <DepositStepRail
            currentStep={1}
            isApproved={false}
            isCheckingAllowance={false}
            isApproving={false}
            isDepositing={false}
            onOpenExplainer={() => setStepExplainerOpen(true)}
          />

          <div className="rh-explainer">
            Connect a wallet so AntSeed can check whether you already approved USDC. If you have, the wizard jumps directly to step&nbsp;2.
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
      ) : step === 'done' ? (
        <div className="rh-success">
          <div className="rh-success-burst" aria-hidden="true">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
              <path d="M5 12.5L10 17.5L19 6.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="rh-success-amount">
            <span className="rh-hero-symbol">$</span>
            {amount || '0'}
            <span className="rh-success-unit">USDC</span>
          </div>
          <div className="rh-success-title">Deposit confirmed</div>
          {depositTxHash && (
            <div className="rh-success-hash">{depositTxHash.slice(0, 10)}…{depositTxHash.slice(-6)}</div>
          )}
          {depositTarget && depositTarget !== address && (
            <div className="rh-success-note">
              Credited to {depositTarget.slice(0, 6)}…{depositTarget.slice(-4)}
            </div>
          )}
          <div className="rh-success-note">
            Your credits are available now. Return to AntSeed Desktop to keep going.
          </div>
          <button type="button" className="rh-cta rh-cta--ghost" onClick={resetForm}>
            Deposit more
          </button>
        </div>
      ) : (
        <>
          {wrongChain && (
            <div className="rh-banner rh-banner--warn" role="alert">
              Wallet is on chain {walletChainId ?? connectedChainId}. Switch to {targetChainName} before depositing.
            </div>
          )}

          {/* ── HERO AMOUNT ── */}
          <div className="rh-hero">
            <div className="rh-hero-cap">
              <span className="rh-hero-label">You're adding</span>
              {balance && maxDeposit > 0 && (
                <button
                  type="button"
                  className="rh-hero-max"
                  onClick={() => setAmount(formatAmountInput(maxDeposit))}
                  disabled={step !== 'idle'}
                >
                  Max ${formatUsd(maxDeposit)}
                </button>
              )}
            </div>
            <label className="rh-hero-amount" aria-label="Deposit amount in USDC">
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
                disabled={step !== 'idle'}
                aria-invalid={validationError != null}
              />
            </label>
            <div className="rh-hero-currency">
              <span className="rh-coin"><UsdcLogo size={14} /></span>
              USDC
              <span className="rh-currency-sep" aria-hidden="true">·</span>
              <span className="rh-coin"><BaseLogo size={14} /></span>
              {targetChainName}
            </div>

            {/* ── INLINE WALLET / LIMIT META ── */}
            <div className="rh-meta rh-meta--hero">
              {balance ? (
                <>
                  {isFirstDeposit && (
                    <span className="rh-meta-pill rh-meta-pill--min">Min ${formatUsd(MIN_FIRST_DEPOSIT)}</span>
                  )}
                  <span className="rh-meta-line">
                    <span className="rh-meta-key">Wallet</span>
                    <span className="rh-meta-val">
                      {walletUsdcKnown ? `$${formatUsd(walletUsdcBalance)}` : '…'}
                    </span>
                  </span>
                  <span className="rh-meta-dot" aria-hidden="true" />
                  <span className="rh-meta-line">
                    <span className="rh-meta-key">Limit left</span>
                    <span className="rh-meta-val">${formatUsd(remainingCreditLimit)}</span>
                  </span>
                </>
              ) : (
                <span className="rh-meta-line">Loading your credit limit…</span>
              )}
            </div>
          </div>

          {/* ── QUICK CHIPS ── */}
          {chipValues.length > 0 && (
            <div className="rh-chips" role="group" aria-label="Quick amount presets">
              {chipValues.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`rh-chip ${amount === String(v) ? 'is-active' : ''}`}
                  onClick={() => setAmount(String(v))}
                  disabled={step !== 'idle'}
                >
                  ${v}
                </button>
              ))}
              {maxDeposit > 0 && (
                <button
                  type="button"
                  className={`rh-chip rh-chip--max ${amount === formatAmountInput(maxDeposit) ? 'is-active' : ''}`}
                  onClick={() => setAmount(formatAmountInput(maxDeposit))}
                  disabled={step !== 'idle'}
                >
                  Max
                </button>
              )}
            </div>
          )}

          {/* ── STEP RAIL ── */}
          <DepositStepRail
            currentStep={currentWizardStep}
            isApproved={hasAllowance}
            isCheckingAllowance={isCheckingAllowance}
            isApproving={step === 'approving'}
            isDepositing={step === 'depositing'}
            onOpenExplainer={() => setStepExplainerOpen(true)}
          />

          {/* ── TRUST STRIP (collapsed) ── */}
          <DepositTrustCard
            onOpenDetails={() => setTrustDetailsOpen(true)}
            balanceKnown={balanceKnown}
            currentTotal={currentTotal}
          />

          <TrustDetailsModal
            isOpen={trustDetailsOpen}
            onClose={() => setTrustDetailsOpen(false)}
            targetChainName={targetChainName}
            walletAddress={address}
            antseedAddress={depositTarget as string | undefined}
            depositsContract={config?.depositsContractAddress}
            usdcContract={config?.usdcContractAddress}
            balanceKnown={balanceKnown}
            currentTotal={currentTotal}
            currentAvailable={currentAvailable}
            currentReserved={currentReserved}
            creditLimit={creditLimit}
            remainingCreditLimit={remainingCreditLimit}
            walletUsdcBalance={walletUsdcBalance}
            walletUsdcKnown={walletUsdcKnown}
            walletUsdcLoading={walletUsdcLoading || walletUsdcFetching}
            maxDeposit={maxDeposit}
            maxDepositReason={maxDepositReason}
          />

          <StepFlowDetailsModal
            isOpen={stepExplainerOpen}
            onClose={() => setStepExplainerOpen(false)}
          />

          {validationError && (
            <div className="rh-banner rh-banner--error" role="alert">
              {validationError}
            </div>
          )}

          {/* ── ADVANCED ── */}
          <div className="rh-advanced">
            <button
              type="button"
              className="rh-advanced-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              aria-controls="deposit-advanced-panel"
            >
              <span className={`rh-advanced-chev ${showAdvanced ? 'is-open' : ''}`} aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 1l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </span>
              Deposit to a different address
            </button>
            {showAdvanced && (
              <div id="deposit-advanced-panel" className="rh-advanced-body">
                <p className="rh-advanced-desc">
                  Deposits credit the AntSeed account whose address you enter below.
                  Anyone can fund any AntSeed account — the balance is still spendable
                  only by that account's signer.
                </p>
                <label className="rh-field-label" htmlFor="deposit-custom-target">Signer address</label>
                <input
                  id="deposit-custom-target"
                  className="rh-field rh-field--mono"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={defaultTarget ?? '0x…'}
                  value={customTarget}
                  onChange={(e) => {
                    setCustomTargetEdited(true);
                    setCustomTarget(e.target.value);
                  }}
                  disabled={step !== 'idle'}
                />
                <div className="rh-advanced-warn" role="note">
                  <span className="rh-advanced-warn-icon" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1l5 9H1l5-9zM6 5v2M6 8.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                  <span>
                    Don't send USDC directly to this address — it won't be credited.
                    Funds must go through the AntSeed Deposits contract.
                  </span>
                </div>
                {customTargetInvalid && (
                  <span className="rh-hint rh-hint--error">Enter a valid 0x… address (42 chars).</span>
                )}
                {isOverridingTarget && (
                  <span className="rh-hint rh-hint--warn">
                    Credits go to {customTargetTrimmed.slice(0, 6)}…{customTargetTrimmed.slice(-4)},
                    not your connected wallet.
                  </span>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="rh-banner rh-banner--error">
              {error}
            </div>
          )}

          {/* ── CTA ── */}
          <button
            type="button"
            className="rh-cta"
            onClick={handleDeposit}
            disabled={step !== 'idle' || !isValidAmount || !config || isSwitchingChain || customTargetInvalid || !depositTarget || allowanceLoading || allowanceFetching || walletUsdcLoading || walletUsdcFetching || !walletUsdcKnown}
          >
            <span>{ctaLabel}</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
          </button>
        </>
      )}
    </div>
  );
}

function DepositTrustCard({
  onOpenDetails,
  balanceKnown,
  currentTotal,
}: {
  onOpenDetails: () => void;
  balanceKnown: boolean;
  currentTotal: number;
}) {
  return (
    <button
      type="button"
      className="rh-trust"
      onClick={onOpenDetails}
      aria-label="Deposit safety details"
    >
      <span className="rh-trust-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5L2 4v4.5c0 3.4 2.6 5.6 6 6.5 3.4-.9 6-3.1 6-6.5V4L8 1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          <path d="M5.5 8l2 2 3.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
      <span className="rh-trust-text">
        <span className="rh-trust-title">USDC stays on-chain</span>
        <span className="rh-trust-sub">Held by the AntSeed Deposits contract</span>
      </span>
      <span className="rh-trust-balance">
        <span className="rh-trust-balance-label">In AntSeed</span>
        <strong>{balanceKnown ? `$${formatUsd(currentTotal)}` : '…'}</strong>
      </span>
      <span className="rh-trust-chev" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </span>
    </button>
  );
}

function TrustDetailsModal({
  isOpen,
  onClose,
  targetChainName,
  walletAddress,
  antseedAddress,
  depositsContract,
  usdcContract,
  balanceKnown,
  currentTotal,
  currentAvailable,
  currentReserved,
  creditLimit,
  remainingCreditLimit,
  walletUsdcBalance,
  walletUsdcKnown,
  walletUsdcLoading,
  maxDeposit,
  maxDepositReason,
}: {
  isOpen: boolean;
  onClose: () => void;
  targetChainName: string;
  walletAddress?: string;
  antseedAddress?: string;
  depositsContract?: string;
  usdcContract?: string;
  balanceKnown: boolean;
  currentTotal: number;
  currentAvailable: number;
  currentReserved: number;
  creditLimit: number;
  remainingCreditLimit: number;
  walletUsdcBalance: number | null;
  walletUsdcKnown: boolean;
  walletUsdcLoading: boolean;
  maxDeposit: number;
  maxDepositReason: 'wallet' | 'limit';
}) {
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="deposit-details-overlay" role="presentation" onClick={onClose}>
      <div
        className="deposit-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-details-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="deposit-details-head">
          <div>
            <div className="deposit-details-eyebrow">Deposit safety</div>
            <h3 id="deposit-details-title">Safe deposit flow</h3>
            <p>USDC stays on-chain in the AntSeed Deposits contract.</p>
          </div>
          <button type="button" className="deposit-details-close" onClick={onClose} aria-label="Close details">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="deposit-details-body">
          <div className="deposit-details-balance-hero">
            <span>In AntSeed now</span>
            <strong>{balanceKnown ? `$${formatUsd(currentTotal)}` : 'Loading…'}</strong>
            <small>{balanceKnown ? `You can deposit up to $${formatUsd(maxDeposit)} now.` : 'Loading account balance and limit…'}</small>
          </div>

          <div className="deposit-balance-details deposit-balance-details--embedded">
            <div className="deposit-balance-breakdown">
              <span>Available {balanceKnown ? `$${formatUsd(currentAvailable)}` : 'Loading…'}</span>
              <span>Reserved {balanceKnown ? `$${formatUsd(currentReserved)}` : 'Loading…'}</span>
            </div>
            <div className="deposit-balance-row">
              <span>Account limit</span>
              <strong>{balanceKnown ? `$${formatUsd(creditLimit)}` : 'Loading…'}</strong>
            </div>
            <div className="deposit-balance-row">
              <span>Can add before limit</span>
              <strong>{balanceKnown ? `$${formatUsd(remainingCreditLimit)}` : 'Loading…'}</strong>
            </div>
            <div className="deposit-balance-row">
              <span>Wallet USDC</span>
              <strong>{walletUsdcKnown ? `$${formatUsd(walletUsdcBalance ?? 0)}` : walletUsdcLoading ? 'Loading…' : '—'}</strong>
            </div>
            <div className="deposit-balance-cap">
              {balanceKnown
                ? <>Max deposit is ${formatUsd(maxDeposit)} based on your {maxDepositReason === 'wallet' ? 'connected wallet USDC balance' : 'remaining AntSeed limit'}. Your deposit availability grows as you use AntSeed and build account history.</>
                : 'Loading your AntSeed balance and account limit…'}
            </div>
          </div>

          <div className="deposit-trust-grid">
            <div className="deposit-trust-item">
              <span>Network</span>
              <strong>{targetChainName}</strong>
            </div>
            <div className="deposit-trust-item">
              <span>Pays from wallet</span>
              <strong>{truncateAddr(walletAddress)}</strong>
            </div>
            <div className="deposit-trust-item">
              <span>Credits AntSeed account</span>
              <strong>{truncateAddr(antseedAddress)}</strong>
            </div>
            <div className="deposit-trust-item">
              <span>USDC contract</span>
              <strong>{truncateAddr(usdcContract)}</strong>
            </div>
            <div className="deposit-trust-item deposit-trust-item--wide">
              <span>Deposits contract</span>
              <strong>{truncateAddr(depositsContract)}</strong>
            </div>
          </div>

          <div className="deposit-trust-foot">
            You'll see two wallet confirmations only when needed: an ERC‑20 approval first, then the deposit itself.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Step-flow explainer modal ──────────────────────────────────────
 * Opens when the user taps the (?) on the two-step rail. Explains why
 * USDC needs a separate approve step before deposit. Visually inherits
 * the same .deposit-details-* modal shell as TrustDetailsModal so the
 * two help-sheets feel like siblings. */
function StepFlowDetailsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="deposit-details-overlay" role="presentation" onClick={onClose}>
      <div
        className="deposit-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rh-step-explainer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="deposit-details-head">
          <div>
            <div className="deposit-details-eyebrow">Deposit flow</div>
            <h3 id="rh-step-explainer-title">Why two steps?</h3>
            <p>
              USDC is an ERC-20 token. ERC-20s require an explicit on-chain authorization
              before any contract can move them — this is a safety property of the token
              standard, not specific to AntSeed.
            </p>
          </div>
          <button type="button" className="deposit-details-close" onClick={onClose} aria-label="Close details">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="deposit-details-body">
          <div className="rh-step-card">
            <span className="rh-step-card-pip" aria-hidden="true">1</span>
            <div className="rh-step-card-body">
              <div className="rh-step-card-title">Approve USDC</div>
              <p className="rh-step-card-desc">
                You sign an ERC-20 <code>approve()</code> telling the AntSeed Deposits
                contract it may move USDC on your behalf — up to the amount you entered.
                No USDC has moved yet.
              </p>
              <ul className="rh-step-card-list">
                <li>Signed in your wallet</li>
                <li>Costs a small gas fee</li>
                <li>Persists on-chain — revocable anytime</li>
              </ul>
            </div>
          </div>

          <div className="rh-step-card">
            <span className="rh-step-card-pip" aria-hidden="true">2</span>
            <div className="rh-step-card-body">
              <div className="rh-step-card-title">Add credits</div>
              <p className="rh-step-card-desc">
                The Deposits contract calls <code>transferFrom()</code> to pull the
                approved USDC into escrow, then credits it to your AntSeed account.
                Funds stay on-chain — AntSeed never custodies them.
              </p>
              <ul className="rh-step-card-list">
                <li>Signed in your wallet</li>
                <li>Costs a small gas fee</li>
                <li>Balance is available immediately on confirmation</li>
              </ul>
            </div>
          </div>

          <div className="deposit-trust-foot">
            If you've previously approved a larger amount, step 1 is skipped automatically.
            You can review or revoke approvals anytime via your wallet or a block explorer.
          </div>
        </div>
      </div>
    </div>
  );
}

// Slim Robinhood-style step rail
function DepositStepRail({
  currentStep,
  isApproved,
  isCheckingAllowance,
  isApproving,
  isDepositing,
  onOpenExplainer,
}: {
  currentStep: 1 | 2;
  isApproved: boolean;
  isCheckingAllowance: boolean;
  isApproving: boolean;
  isDepositing: boolean;
  onOpenExplainer?: () => void;
}) {
  const step1Done = isApproved;
  const step2Done = false;
  const step1Active = currentStep === 1 && !isApproved;
  const step2Active = currentStep === 2;
  const fillPct = isDepositing ? 100 : isApproved ? 50 : isCheckingAllowance ? 35 : isApproving ? 20 : 0;

  const step1Caption =
    isApproving ? 'Confirm in wallet'
    : isCheckingAllowance ? 'Checking…'
    : isApproved ? 'Approved'
    : 'Approve USDC';
  const step2Caption =
    isDepositing ? 'Confirming…'
    : isApproved ? 'Ready to deposit'
    : 'Add credits';

  const interactive = !!onOpenExplainer;
  const RailTag = interactive ? 'button' : 'div';
  const railProps = interactive
    ? { type: 'button' as const, onClick: onOpenExplainer, 'aria-label': 'Why two steps? Tap for details' }
    : { 'aria-label': 'Deposit progress' };

  return (
    <RailTag className={`rh-rail${interactive ? ' rh-rail--interactive' : ''}`} {...railProps}>
      <div className={`rh-rail-step ${step1Active ? 'is-active' : ''} ${step1Done ? 'is-done' : ''}`}>
        <div className="rh-rail-pip">
          {step1Done ? (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <span className="rh-rail-num">1</span>
          )}
          {step1Active && <span className="rh-rail-ring" aria-hidden="true" />}
        </div>
        <div className="rh-rail-meta">
          <div className="rh-rail-label">Step 1</div>
          <div className="rh-rail-caption">{step1Caption}</div>
        </div>
      </div>

      <div className="rh-rail-line">
        <div className="rh-rail-line-fill" style={{ width: `${fillPct}%` }} />
      </div>

      <div className={`rh-rail-step ${step2Active ? 'is-active' : ''} ${step2Done ? 'is-done' : ''} ${!isApproved && !step2Active ? 'is-locked' : ''}`}>
        <div className="rh-rail-pip">
          <span className="rh-rail-num">2</span>
          {step2Active && <span className="rh-rail-ring" aria-hidden="true" />}
        </div>
        <div className="rh-rail-meta">
          <div className="rh-rail-label">Step 2</div>
          <div className="rh-rail-caption">{step2Caption}</div>
        </div>
      </div>

    </RailTag>
  );
}

/* ── Credit Card (coming soon) ── */

function CardDepositPlaceholder() {
  return (
    <div className="rh-form">
      <div className="rh-coming">
        <div className="rh-coming-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/><line x1="1" y1="6.5" x2="15" y2="6.5" stroke="currentColor" strokeWidth="1.4"/><line x1="4" y1="9.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </div>
        <div className="rh-coming-title">Credit card deposits, soon</div>
        <div className="rh-coming-desc">
          We're integrating direct card deposits. For now, fund your account with a crypto wallet.
        </div>
      </div>
    </div>
  );
}
