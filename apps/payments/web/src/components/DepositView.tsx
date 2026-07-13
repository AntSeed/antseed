import { useState, useEffect, useCallback } from 'react';
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
import { formatAmountInput, formatUsd, parseUsd, truncateAddress } from '../utils/format';
import { getExplorerTxUrl } from '../utils/txLink';
import { ConnectWalletAction } from './ConnectWalletAction';
import './DepositView.scss';

const MIN_FIRST_DEPOSIT = 1; // USDC — matches AntseedDeposits.MIN_BUYER_DEPOSIT
const QUICK_CHIPS = [10, 25, 50, 100] as const;

function safeParseUsdc(value: string): bigint {
  try {
    return parseUnits(value || '0', 6);
  } catch {
    return 0n;
  }
}

interface DepositViewProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerAddress: string | null;
  onDeposited: () => void;
  /** Prefill for the amount field (USD), e.g. when the desktop app hands off. */
  initialAmount?: string;
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

export function DepositView({ config, balance, buyerAddress, onDeposited, initialAmount }: DepositViewProps) {
  return (
    <div className="dv">
      <CryptoDeposit
        config={config}
        balance={balance}
        buyerAddress={buyerAddress}
        onDeposited={onDeposited}
        initialAmount={initialAmount}
      />
    </div>
  );
}

/* ── Crypto Deposit ── */

function CryptoDeposit({
  config,
  balance,
  buyerAddress,
  onDeposited,
  initialAmount,
}: {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerAddress: string | null;
  onDeposited: () => void;
  initialAmount?: string;
}) {
  const { address, isConnected } = useAccount();
  const walletConnected = isConnected && Boolean(address);
  const connectedChainId = useChainId();
  const [amount, setAmount] = useState(initialAmount ?? '');
  const [activeChip, setActiveChip] = useState<number | 'max' | null>(null);
  const [step, setStep] = useState<'idle' | 'approving' | 'checking-allowance' | 'depositing' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [depositedTxHash, setDepositedTxHash] = useState<string | null>(null);
  const [showTargetOverride, setShowTargetOverride] = useState(false);
  const [customTarget, setCustomTarget] = useState('');
  const [customTargetEdited, setCustomTargetEdited] = useState(false);

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

  useEffect(() => {
    if (customTargetEdited || !defaultTarget) return;
    setCustomTarget(defaultTarget);
  }, [customTargetEdited, defaultTarget]);

  const customTargetTrimmed = customTarget.trim();
  const customTargetIsValid = /^0x[a-fA-F0-9]{40}$/.test(customTargetTrimmed);
  const customTargetInvalid = showTargetOverride && customTargetTrimmed !== '' && !customTargetIsValid;
  const depositTarget = showTargetOverride && customTargetIsValid
    ? customTargetTrimmed
    : defaultTarget;
  const isOverridingTarget = showTargetOverride
    && customTargetIsValid
    && Boolean(defaultTarget)
    && customTargetTrimmed.toLowerCase() !== defaultTarget?.toLowerCase();

  // Wallet USDC balance
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
    query: { enabled: walletConnected && !!config && !!address },
  });
  const walletUsdcBalance = walletUsdcRaw === undefined
    ? null
    : Number.parseFloat(formatUnits(walletUsdcRaw, 6));
  const walletUsdcKnown = walletUsdcBalance !== null && Number.isFinite(walletUsdcBalance);
  const maxDeposit = Math.max(
    0,
    Math.min(
      remainingCreditLimit,
      walletUsdcKnown ? walletUsdcBalance : remainingCreditLimit,
    ),
  );

  // Default amount once data loads
  useEffect(() => {
    if (amount !== '' || !balance) return;
    const suggested = maxDeposit >= 10 ? '10' : maxDeposit > 0 ? formatAmountInput(maxDeposit) : '';
    if (suggested) {
      setAmount(suggested);
      const chipVal = [10, 25, 50, 100].find((c) => c === Number(suggested));
      if (chipVal) setActiveChip(chipVal);
    }
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

  // Read on-chain allowance
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
    query: { enabled: walletConnected && !!config && !!address },
  });

  const usdcAmount = safeParseUsdc(amount);
  const allowanceKnown = allowance !== undefined;
  const isCheckingAllowance = allowanceLoading || allowanceFetching || step === 'checking-allowance';
  const hasAllowance = allowanceKnown && allowance >= usdcAmount && usdcAmount > 0n;
  const allowanceShortfall = isValidAmount && allowanceKnown && allowance < usdcAmount;
  const needsApproval = allowanceShortfall;

  // Step 1 = needs approval, step 2 = has allowance & ready to deposit
  const currentWizardStep = !isValidAmount ? 1 : hasAllowance ? 2 : 1;

  // Approve USDC
  const { writeContract: writeApprove, data: approveTxHash, reset: resetApprove } = useWriteContract();
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    chainId: expectedChainId,
    query: { enabled: step === 'approving' && !!approveTxHash },
  });

  const { writeContract: writeDeposit, data: depositTxHash, reset: resetDeposit } = useWriteContract();
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

  // After deposit confirms, show the real tx result and let the parent refresh
  // from the payments API. Avoid inventing local balance values here.
  useEffect(() => {
    if (step !== 'depositing' || !depositConfirmed) return;
    setDepositedTxHash(depositTxHash ?? null);
    setStep('done');
    onDeposited();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositConfirmed, step]);

  const handleAmountChange = useCallback((value: string) => {
    setAmount(value);
    // Clear chip selection when user types freely
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) {
      const chipVal = QUICK_CHIPS.find((c) => c === n);
      setActiveChip(chipVal ?? null);
    } else {
      setActiveChip(null);
    }
  }, []);

  const selectChip = useCallback((chip: number | 'max') => {
    setActiveChip(chip);
    if (chip === 'max') {
      setAmount(formatAmountInput(maxDeposit));
    } else {
      setAmount(String(chip));
    }
  }, [maxDeposit]);

  async function handleAction() {
    if (!address || !isValidAmount || !config || !depositTarget) return;
    setError(null);
    setErrorDetail(null);

    try {
      await ensureCorrectNetwork();
    } catch (err) {
      setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      return;
    }

    resetApprove();
    resetDeposit();

    // Refresh balances
    const walletResult = await refetchWalletUsdc();
    const latestWalletUsdc = walletResult.data === undefined
      ? null
      : Number.parseFloat(formatUnits(walletResult.data, 6));
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
      writeDeposit(
        {
          address: config.depositsContractAddress as `0x${string}`,
          abi: DEPOSITS_ABI,
          functionName: 'deposit',
          chainId: expectedChainId,
          args: [depositTarget as `0x${string}`, usdcAmount],
        },
        {
          onError: (err) => {
            setStep('idle');
            setError(getErrorMessage(err));
          },
        },
      );
      return;
    }

    // Step 1: approve USDC first. The user will click again to deposit after
    // approval is confirmed and allowance has been rechecked.
    setStep('approving');
    writeApprove(
      {
        address: config.usdcContractAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        chainId: expectedChainId,
        args: [config.depositsContractAddress as `0x${string}`, usdcAmount],
      },
      {
        onError: (err) => {
          setStep('idle');
          setError(getErrorMessage(err));
        },
      },
    );
  }

  function resetForm() {
    setStep('idle');
    setError(null);
    setErrorDetail(null);
    setErrorOpen(false);
    setDepositedTxHash(null);
    resetApprove();
    resetDeposit();
    setAmount('');
    setActiveChip(null);
  }

  const explorerUrl = depositedTxHash
    ? getExplorerTxUrl(depositedTxHash, expectedChainId ?? connectedChainId)
    : null;

  const isWorking = step === 'approving' || step === 'depositing' || step === 'checking-allowance';
  const isLoadingWallet = walletUsdcLoading || walletUsdcFetching;
  const isLoadingAllowance = allowanceLoading || allowanceFetching;

  /* ── Done state ── */
  if (step === 'done') {
    return (
      <div className="dv-success">
        <div className="dv-success-icon" aria-hidden="true">✓</div>
        <div className="dv-success-title">Deposit confirmed!</div>
        <div className="dv-success-amount">${formatUsd(amountNum)} USDC</div>
        <div className="dv-success-note">
          The transaction confirmed. Your balance will refresh from the payments server.
        </div>
        {depositedTxHash && (
          <div className="dv-success-hash">
            {explorerUrl ? (
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="dv-success-hash-link">
                {depositedTxHash.slice(0, 10)}…{depositedTxHash.slice(-8)}
                <span className="dv-success-hash-arrow" aria-hidden="true">↗</span>
              </a>
            ) : (
              <span>{depositedTxHash.slice(0, 10)}…{depositedTxHash.slice(-8)}</span>
            )}
          </div>
        )}
        <button className="dv-btn-outline" onClick={resetForm}>
          Add more funds
        </button>
      </div>
    );
  }

  /* ── Not connected ── */
  if (!walletConnected) {
    return (
      <div className="dv-form">
        <div className="dv-connect-hint">
          Connect a wallet so AntSeed can check whether you already approved USDC. If you have, this wizard will jump directly to step 2.
        </div>
        <ConnectWalletAction className="dv-btn-primary" />
      </div>
    );
  }

  /* ── Main form ── */
  const actionButtonLabel = (() => {
    if (isSwitchingChain) return `Switching to ${targetChainName}...`;
    if (wrongChain) return `Switch to ${targetChainName}`;
    if (isLoadingWallet || !walletUsdcKnown) return 'Loading wallet USDC...';
    if (isCheckingAllowance) return 'Checking approval...';
    if (step === 'approving') return 'Approve USDC in wallet...';
    if (step === 'depositing') return 'Depositing...';
    if (needsApproval) return `Step 1: Approve ${amount || '0'} USDC`;
    return 'Step 2: Deposit USDC';
  })();

  const actionButtonDisabled =
    isWorking ||
    !isValidAmount ||
    !config ||
    isSwitchingChain ||
    customTargetInvalid ||
    !depositTarget ||
    isLoadingAllowance ||
    isLoadingWallet ||
    !walletUsdcKnown;

  return (
    <div className="dv-form">
      {wrongChain && (
        <div className="dv-chain-warn" role="alert">
          Wallet is on chain {walletChainId ?? connectedChainId}. Switch to {targetChainName} to continue.
        </div>
      )}

      {/* Amount field */}
      <div className="dv-amount-block">
        <label className="dv-amount-label" htmlFor="dv-amount-input">
          Amount to add
        </label>
        <div className={`dv-amount-field${amount && validationError ? ' dv-amount-field--error' : ''}`}>
          <span className="dv-amount-cur" aria-hidden="true">$</span>
          <input
            id="dv-amount-input"
            className="dv-amount-input"
            type="number"
            inputMode="decimal"
            min={minDeposit || 0}
            max={maxDeposit || undefined}
            step="0.01"
            placeholder={isFirstDeposit ? '10.00' : '0.00'}
            value={amount}
            onChange={(e) => handleAmountChange(e.target.value)}
            disabled={isWorking}
            aria-describedby="dv-amount-hint"
            autoFocus
          />
          <span className="dv-amount-unit" aria-hidden="true">USDC</span>
        </div>

        {/* Quick chips */}
        <div className="dv-chips" role="group" aria-label="Quick amount">
          {QUICK_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className={`dv-chip${activeChip === chip ? ' dv-chip--active' : ''}${chip > maxDeposit && maxDeposit > 0 ? ' dv-chip--disabled' : ''}`}
              onClick={() => selectChip(chip)}
              disabled={isWorking || (chip > maxDeposit && maxDeposit > 0)}
              aria-pressed={activeChip === chip}
            >
              ${chip}
            </button>
          ))}
          <button
            type="button"
            className={`dv-chip${activeChip === 'max' ? ' dv-chip--active' : ''}${maxDeposit <= 0 ? ' dv-chip--disabled' : ''}`}
            onClick={() => selectChip('max')}
            disabled={isWorking || maxDeposit <= 0}
            aria-pressed={activeChip === 'max'}
          >
            Max
          </button>
        </div>

        {/* Wallet balance inline */}
        <div id="dv-amount-hint" className="dv-wallet-hint">
          {isLoadingWallet && !walletUsdcKnown ? (
            <span className="dv-wallet-hint-loading">Loading wallet balance…</span>
          ) : walletUsdcKnown && address ? (
            <span>
              <span className="dv-wallet-hint-addr">{truncateAddress(address)}</span>
              {' · '}
              <strong className="dv-wallet-hint-bal">${formatUsd(walletUsdcBalance ?? 0)} USDC</strong>
              {' available in wallet'}
            </span>
          ) : null}
          {balanceKnown && remainingCreditLimit < (walletUsdcBalance ?? Infinity) && remainingCreditLimit > 0 && (
            <span className="dv-wallet-hint-limit">
              {' · '}${formatUsd(remainingCreditLimit)} deposit headroom
            </span>
          )}
        </div>

        {validationError && (
          <div className="dv-validation-error" role="alert">{validationError}</div>
        )}
      </div>

      <div className="dv-target">
        <button
          type="button"
          className="dv-target-toggle"
          onClick={() => setShowTargetOverride((open) => !open)}
          aria-expanded={showTargetOverride}
          aria-controls="dv-target-panel"
          disabled={isWorking}
        >
          Different AntSeed address
        </button>
        {showTargetOverride && (
          <div id="dv-target-panel" className="dv-target-panel">
            <input
              className={`dv-target-input${customTargetInvalid ? ' dv-target-input--error' : ''}`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={defaultTarget ?? '0x...'}
              value={customTarget}
              onChange={(event) => {
                setCustomTargetEdited(true);
                setCustomTarget(event.target.value);
              }}
              disabled={isWorking}
            />
            <div className={`dv-target-note${customTargetInvalid ? ' dv-target-note--error' : ''}`}>
              {customTargetInvalid
                ? 'Enter a valid 0x… address (42 chars).'
                : isOverridingTarget
                  ? `Crediting ${truncateAddress(customTargetTrimmed, 6, 4, '...')}.`
                  : 'Credits go to this AntSeed account via the Deposits contract.'}
            </div>
          </div>
        )}
      </div>

      <div className="dv-direct-warning" role="note">
        Do not send USDC directly to your AntSeed address. It will not be
        credited. Use this deposit flow so funds go through the AntSeed
        Deposits contract.
      </div>

      {/* Two-step stepper */}
      <div className="dv-steps" aria-label="Deposit steps">
        <div className={`dv-step${hasAllowance ? ' dv-step--done' : currentWizardStep === 1 ? ' dv-step--active' : ''}`}>
          <span className="dv-step-dot" aria-hidden="true">
            {hasAllowance ? '✓' : '1'}
          </span>
          <span className="dv-step-label">
            {hasAllowance
              ? 'Already approved. You can skip straight to step 2.'
              : step === 'approving'
                ? 'Confirm approval in your wallet. This does not move funds.'
                : step === 'checking-allowance'
                  ? 'Checking your existing approval on-chain…'
                  : `Permit AntSeed's Deposits contract to use ${amount || 'your chosen amount'} USDC. Approval only grants permission.`}
          </span>
        </div>
        <div className={`dv-step${currentWizardStep === 2 && !isWorking ? ' dv-step--active' : step === 'depositing' ? ' dv-step--active' : ''}`}>
          <span className="dv-step-dot" aria-hidden="true">2</span>
          <span className="dv-step-label">
            {step === 'depositing'
              ? 'Confirm the deposit transaction. This moves USDC into your AntSeed balance.'
              : currentWizardStep === 2
                ? 'Approval detected. The next click deposits USDC into your AntSeed balance.'
                : 'Locked until approval is confirmed.'}
          </span>
        </div>
      </div>

      {/* Primary action */}
      <button
        className="dv-btn-primary"
        onClick={handleAction}
        disabled={actionButtonDisabled}
        aria-busy={isWorking}
      >
        {actionButtonLabel}
      </button>

      {/* Approving note */}
      {needsApproval && !isWorking && (
        <div className="dv-approve-note">
          Approves only this deposit amount. After approval confirms, confirm the deposit.
        </div>
      )}

      {/* Confirm note (step 2 ready) */}
      {!needsApproval && isValidAmount && !isWorking && (
        <div className="dv-confirm-note">
          Wallet confirmation required.
        </div>
      )}

      {/* Helper text */}
      <div className="dv-help">
        Funds credit your available balance right after the transaction confirms. Withdraw unused funds anytime.
      </div>

      {/* Error with expandable detail */}
      {error && (
        <div className="dv-error" role="alert">
          <div className="dv-error-summary">
            <span>{error}</span>
            {errorDetail && (
              <button
                type="button"
                className="dv-error-toggle"
                onClick={() => setErrorOpen((v) => !v)}
                aria-expanded={errorOpen}
              >
                {errorOpen ? 'Hide detail' : 'Show detail'}
              </button>
            )}
          </div>
          {errorOpen && errorDetail && (
            <div className="dv-error-detail">{errorDetail}</div>
          )}
          {depositTxHash && (
            <div className="dv-error-hash">
              {getExplorerTxUrl(depositTxHash, expectedChainId ?? connectedChainId) ? (
                <a
                  href={getExplorerTxUrl(depositTxHash, expectedChainId ?? connectedChainId)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dv-error-hash-link"
                >
                  View tx ↗
                </a>
              ) : (
                <span className="dv-error-hash-raw">{depositTxHash.slice(0, 18)}…</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
