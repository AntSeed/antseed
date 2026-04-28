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
import type { BalanceData, PaymentConfig } from '../types';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import './DepositView.scss';

const MIN_FIRST_DEPOSIT = 1; // USDC — matches AntseedDeposits.MIN_BUYER_DEPOSIT

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseUsd(value?: string | null): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAmountInput(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(6).replace(/\.?(0+)$/, '');
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

const DEPOSITS_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

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

        <div className="deposit-methods">
          <button
            className={`deposit-method ${method === 'crypto' ? 'deposit-method--active' : ''}`}
            onClick={() => setMethod('crypto')}
          >
            <span className="deposit-method-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 4.5V11.5L8 15L15 11.5V4.5L8 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M1 4.5L8 8M8 8L15 4.5M8 8V15" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
            </span>
            <span className="deposit-method-label">Crypto Wallet</span>
            <span className="deposit-method-desc">MetaMask, Coinbase, etc.</span>
          </button>
          <button
            className={`deposit-method ${method === 'card' ? 'deposit-method--active' : ''}`}
            onClick={() => setMethod('card')}
          >
            <span className="deposit-method-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.2"/><line x1="1" y1="6.5" x2="15" y2="6.5" stroke="currentColor" strokeWidth="1.2"/><line x1="4" y1="9.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </span>
            <span className="deposit-method-label">Credit Card</span>
            <span className="deposit-method-desc">Coming soon</span>
          </button>
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
  useEffect(() => {
    if (amount !== '' || !balance) return;
    const suggested = getSuggestedDeposit(maxDeposit, isFirstDeposit);
    if (suggested) setAmount(suggested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance, walletUsdcRaw]);

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

  return (
    <div className="deposit-form">
      {!isConnected ? (
        <>
          <DepositWizard
            currentStep={1}
            isApproved={false}
            isCheckingAllowance={false}
            isApproving={false}
            isDepositing={false}
            amount={amount || 'your chosen amount'}
          />
          <div className="deposit-connect-explainer">
            Connect a wallet so AntSeed can check whether you already approved USDC. If you have, this wizard will jump directly to step 2.
          </div>
          <div className="deposit-connect-wrapper">
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={openConnectModal}
                  disabled={!mounted}
                >
                  Connect Wallet
                </button>
              )}
            </ConnectButton.Custom>
          </div>
        </>
      ) : step === 'done' ? (
        <div className="deposit-success">
          <div className="deposit-success-icon">&#10003;</div>
          <div className="deposit-success-title">Deposit confirmed!</div>
          <div className="deposit-success-hash">{depositTxHash?.slice(0, 18)}...</div>
          {depositTarget && depositTarget !== address && (
            <div className="deposit-success-note">
              Credits added to {depositTarget.slice(0, 6)}...{depositTarget.slice(-4)}
            </div>
          )}
          <div className="deposit-success-note">
            Your credits are now available. You can return to AntSeed Desktop to continue.
          </div>
          <button className="btn-outline" onClick={resetForm} style={{ marginTop: 12 }}>
            Deposit more
          </button>
        </div>
      ) : (
        <>
          {wrongChain && (
            <div className="status-msg" style={{ marginTop: 0, marginBottom: 16 }}>
              Wallet is on chain {walletChainId ?? connectedChainId}. Switch to {targetChainName} before depositing.
            </div>
          )}

          <DepositWizard
            currentStep={currentWizardStep}
            isApproved={hasAllowance}
            isCheckingAllowance={isCheckingAllowance}
            isApproving={step === 'approving'}
            isDepositing={step === 'depositing'}
            amount={amount || '0'}
          />

          <DepositTrustCard
            onOpenDetails={() => setTrustDetailsOpen(true)}
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

          <div className="input-group">
            <div className="deposit-amount-head">
              <label className="input-label">Amount to add (USDC)</label>
              {balance && maxDeposit > 0 && (
                <button
                  type="button"
                  className="deposit-amount-max"
                  onClick={() => setAmount(formatAmountInput(maxDeposit))}
                  disabled={step !== 'idle'}
                >
                  Max ${formatUsd(maxDeposit)}
                </button>
              )}
            </div>
            <input
              className="input-field"
              type="number"
              min={minDeposit || 0}
              max={maxDeposit || undefined}
              step="0.01"
              placeholder={isFirstDeposit ? '10.00' : '0.00'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={step !== 'idle'}
            />
            {balance ? (
              <span className="hint">
                {isFirstDeposit
                  ? `Min ${MIN_FIRST_DEPOSIT} USDC · `
                  : ''}
                Add up to ${formatUsd(maxDeposit)} now — ${formatUsd(remainingCreditLimit)} remaining limit, {walletUsdcKnown ? `${formatUsd(walletUsdcBalance)} USDC in wallet` : 'wallet balance loading'}.
              </span>
            ) : (
              <span className="hint">Loading your credit limit…</span>
            )}
          </div>

          {validationError && (
            <div className="status-msg status-error" role="alert">
              {validationError}
            </div>
          )}

          <div className="deposit-advanced">
            <button
              type="button"
              className="deposit-advanced-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              aria-controls="deposit-advanced-panel"
            >
              <span className={`deposit-advanced-chevron ${showAdvanced ? 'deposit-advanced-chevron--open' : ''}`} aria-hidden="true">›</span>
              Advanced — deposit to a different address
            </button>
            {showAdvanced && (
              <div id="deposit-advanced-panel" className="deposit-advanced-body">
                <p className="deposit-advanced-desc">
                  Deposits credit the AntSeed account whose address you enter below.
                  Anyone can fund any AntSeed account — the balance is still spendable
                  only by that account's signer. Override only if you mean to top up
                  someone else's AntSeed account (e.g. a teammate). This does not change
                  which account spends the credits.
                </p>
                <label className="input-label" htmlFor="deposit-custom-target">Signer address</label>
                <input
                  id="deposit-custom-target"
                  className="input-field input-field--mono"
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
                <div className="deposit-advanced-warn" role="note">
                  <span className="deposit-advanced-warn-icon" aria-hidden="true">⚠</span>
                  <span>
                    Do not send USDC directly to this address — it will not be credited.
                    Use the Deposit button below; funds must go through the AntSeed
                    Deposits contract.
                  </span>
                </div>
                {customTargetInvalid && (
                  <span className="hint hint--error">Enter a valid 0x… address (42 chars).</span>
                )}
                {isOverridingTarget && (
                  <span className="hint hint--warn">
                    Credits will go to {customTargetTrimmed.slice(0, 6)}…{customTargetTrimmed.slice(-4)},
                    not your connected wallet.
                  </span>
                )}
              </div>
            )}
          </div>

          <button
            className="btn-primary"
            onClick={handleDeposit}
            disabled={step !== 'idle' || !isValidAmount || !config || isSwitchingChain || customTargetInvalid || !depositTarget || allowanceLoading || allowanceFetching || walletUsdcLoading || walletUsdcFetching || !walletUsdcKnown}
          >
            {isSwitchingChain ? `Switching to ${targetChainName}...` :
             wrongChain ? `Switch to ${targetChainName}` :
             walletUsdcLoading || walletUsdcFetching || !walletUsdcKnown ? 'Loading wallet USDC...' :
             isCheckingAllowance ? 'Checking approval...' :
             step === 'approving' ? 'Approve USDC in wallet...' :
             step === 'depositing' ? 'Depositing...' :
             allowanceShortfall ? `Step 1: Approve ${amount || '0'} USDC` :
             'Step 2: Deposit USDC'}
          </button>
        </>
      )}

      {error && (
        <div className="status-msg status-error">
          {error}
        </div>
      )}
    </div>
  );
}

function shortAddress(addr?: string | null): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
}

function DepositTrustCard({
  onOpenDetails,
  balanceKnown,
  currentTotal,
  maxDeposit,
}: {
  onOpenDetails: () => void;
  balanceKnown: boolean;
  currentTotal: number;
  maxDeposit: number;
}) {
  return (
    <div className="deposit-trust-card" role="note" aria-label="Deposit safety summary">
      <button
        type="button"
        className="deposit-trust-toggle"
        onClick={onOpenDetails}
      >
        <span className="deposit-trust-shield" aria-hidden="true">✓</span>
        <span className="deposit-trust-head-copy">
          <span className="deposit-trust-title">Safe deposit flow</span>
          <span className="deposit-trust-subtitle">USDC stays on-chain in the AntSeed Deposits contract.</span>
        </span>
        <span className="deposit-trust-balance-summary">
          <span>In AntSeed</span>
          <strong>{balanceKnown ? `$${formatUsd(currentTotal)}` : 'Loading…'}</strong>
          <em>{balanceKnown ? `Max $${formatUsd(maxDeposit)}` : 'Loading…'}</em>
        </span>
        <span className="deposit-trust-chevron" aria-hidden="true">›</span>
      </button>
    </div>
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
          <button type="button" className="deposit-details-close" onClick={onClose} aria-label="Close details">×</button>
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
              <strong>{shortAddress(walletAddress)}</strong>
            </div>
            <div className="deposit-trust-item">
              <span>Credits AntSeed account</span>
              <strong>{shortAddress(antseedAddress)}</strong>
            </div>
            <div className="deposit-trust-item">
              <span>USDC contract</span>
              <strong>{shortAddress(usdcContract)}</strong>
            </div>
            <div className="deposit-trust-item deposit-trust-item--wide">
              <span>Deposits contract</span>
              <strong>{shortAddress(depositsContract)}</strong>
            </div>
          </div>

          <div className="deposit-trust-foot">
            You will see two wallet confirmations only when needed: first an ERC‑20 approval, then the actual deposit.
          </div>
        </div>
      </div>
    </div>
  );
}

function DepositWizard({
  currentStep,
  isApproved,
  isCheckingAllowance,
  isApproving,
  isDepositing,
  amount,
}: {
  currentStep: 1 | 2;
  isApproved: boolean;
  isCheckingAllowance: boolean;
  isApproving: boolean;
  isDepositing: boolean;
  amount: string;
}) {
  return (
    <div className="deposit-wizard" aria-label="Deposit wizard">
      <div className="deposit-wizard-track" aria-hidden="true">
        <span className="deposit-wizard-track-fill" style={{ width: currentStep === 2 ? '100%' : '0%' }} />
      </div>
      <div className={`deposit-wizard-step ${currentStep === 1 ? 'deposit-wizard-step--active' : 'deposit-wizard-step--complete'}`}>
        <div className="deposit-wizard-number">{isApproved ? '✓' : '1'}</div>
        <div className="deposit-wizard-content">
          <div className="deposit-wizard-kicker">Step 1</div>
          <div className="deposit-wizard-title">Approve USDC</div>
          <div className="deposit-wizard-copy">
            {isCheckingAllowance
              ? 'Checking your existing approval on-chain…'
              : isApproved
                ? 'Already approved. You can skip straight to step 2.'
                : isApproving
                  ? 'Confirm approval in your wallet. This does not move funds.'
                  : `Permit AntSeed's Deposits contract to use ${amount} USDC. Approval only grants permission.`}
          </div>
        </div>
      </div>
      <div className={`deposit-wizard-step ${currentStep === 2 ? 'deposit-wizard-step--active' : 'deposit-wizard-step--locked'}`}>
        <div className="deposit-wizard-number">2</div>
        <div className="deposit-wizard-content">
          <div className="deposit-wizard-kicker">Step 2</div>
          <div className="deposit-wizard-title">Deposit credits</div>
          <div className="deposit-wizard-copy">
            {isDepositing
              ? 'Confirm the deposit transaction. This moves USDC into your AntSeed balance.'
              : isApproved
                ? 'Approval detected. The next click deposits USDC into your AntSeed balance.'
                : 'Locked until approval is confirmed.'}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Credit Card (coming soon) ── */

function CardDepositPlaceholder() {
  return (
    <div className="deposit-form">
      <div className="deposit-card-coming">
        <div className="deposit-card-coming-icon">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.2"/><line x1="1" y1="6.5" x2="15" y2="6.5" stroke="currentColor" strokeWidth="1.2"/><line x1="4" y1="9.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
        </div>
        <div className="deposit-card-coming-title">Credit card deposits coming soon</div>
        <div className="deposit-card-coming-desc">
          Direct credit card deposits are being integrated.
          For now, use the crypto wallet option.
        </div>
      </div>
    </div>
  );
}
