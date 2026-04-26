import { useState, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useChainId,
  useWriteContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from 'wagmi';
import { parseUnits } from 'viem';
import type { BalanceData, PaymentConfig } from '../types';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import './DepositView.scss';

const MIN_FIRST_DEPOSIT = 1; // USDC — matches AntseedDeposits.MIN_BUYER_DEPOSIT

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const [step, setStep] = useState<'idle' | 'approving' | 'depositing' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customTarget, setCustomTarget] = useState('');
  const [customTargetEdited, setCustomTargetEdited] = useState(false);

  const currentTotal = balance ? parseFloat(balance.total) : 0;
  const creditLimit = balance ? parseFloat(balance.creditLimit) : 0;
  const maxDeposit = Math.max(0, creditLimit - currentTotal);
  const isFirstDeposit = currentTotal === 0;
  const minDeposit = isFirstDeposit ? MIN_FIRST_DEPOSIT : 0;

  // Default amount: suggest 10 USDC capped by remaining headroom (min 1 on first deposit).
  useEffect(() => {
    if (amount !== '' || !balance) return;
    if (maxDeposit <= 0) return;
    const floor = isFirstDeposit ? MIN_FIRST_DEPOSIT : 0;
    const suggested = Math.max(floor, Math.min(10, maxDeposit));
    setAmount(suggested.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance]);

  const amountNum = amount ? parseFloat(amount) : 0;
  let validationError: string | null = null;
  if (amount !== '' && balance) {
    if (isNaN(amountNum) || amountNum <= 0) {
      validationError = 'Enter a valid amount';
    } else if (amountNum < minDeposit) {
      validationError = `Minimum first deposit is ${minDeposit} USDC`;
    } else if (amountNum > maxDeposit) {
      validationError = maxDeposit <= 0
        ? 'You have reached your credit limit'
        : `Exceeds your credit limit — max deposit is ${formatUsd(maxDeposit)} USDC`;
    }
  }
  const isValidAmount = amount !== '' && !validationError && amountNum > 0;

  const {
    expectedChainId,
    targetChainName,
    walletChainId,
    wrongChain,
    isSwitchingChain,
    ensureCorrectNetwork,
  } = usePaymentNetwork(config);
  const defaultTarget = buyerAddress ?? address;

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
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: config?.usdcContractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    chainId: expectedChainId,
    args: [address as `0x${string}`, config?.depositsContractAddress as `0x${string}`],
    query: { enabled: isConnected && !!config && !!address },
  });

  const usdcAmount = parseUnits(amount || '0', 6);
  const hasAllowance = allowance !== undefined && allowance >= usdcAmount && usdcAmount > 0n;

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

  // Simulate deposit — only when allowance is sufficient
  const { data: depositSim } = useSimulateContract({
    address: config?.depositsContractAddress as `0x${string}`,
    abi: DEPOSITS_ABI,
    functionName: 'deposit',
    chainId: expectedChainId,
    args: [depositTarget as `0x${string}`, usdcAmount],
    query: { enabled: hasAllowance && !!config && !!depositTarget, retry: 3, retryDelay: 2000 },
  });

  // Deposit (uses pre-simulated request)
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

  // After approval confirms → refetch allowance (triggers simulation via hasAllowance)
  useEffect(() => {
    if (step !== 'approving' || !approveConfirmed) return;
    refetchAllowance();
  }, [step, approveConfirmed, refetchAllowance]);

  // Once simulation succeeds after approval → send deposit
  useEffect(() => {
    if (step !== 'approving' || !depositSim?.request) return;
    setStep('depositing');
    writeDeposit({ ...depositSim.request, chainId: expectedChainId }, {
      onError: (err) => {
        setStep('idle');
        setError(getErrorMessage(err));
      },
    });
  }, [step, depositSim, expectedChainId, writeDeposit]);

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

    // Allowance already sufficient — simulation is ready, send deposit directly
    if (depositSim?.request) {
      setStep('depositing');
      const { gas: _gas, ...depositRequest } = depositSim.request;
      writeDeposit({ ...depositRequest, chainId: expectedChainId }, {
        onError: (err) => {
          setStep('idle');
          setError(getErrorMessage(err));
        },
      });
      return;
    }

    // Need approval first
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
    if (maxDeposit > 0) {
      const floor = isFirstDeposit ? MIN_FIRST_DEPOSIT : 0;
      setAmount(Math.max(floor, Math.min(10, maxDeposit)).toString());
    } else {
      setAmount('');
    }
    resetApprove();
    resetDeposit();
  }

  return (
    <div className="deposit-form">
      {!isConnected ? (
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
          <div className="deposit-connected">
            <div className="deposit-connected-dot" />
            <span className="deposit-connected-addr">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
            <span className="deposit-connected-label">Connected</span>
          </div>

          {wrongChain && (
            <div className="status-msg" style={{ marginTop: 0, marginBottom: 16 }}>
              Wallet is on chain {walletChainId ?? connectedChainId}. Switch to {targetChainName} before depositing.
            </div>
          )}

          <div className="input-group">
            <div className="deposit-amount-head">
              <label className="input-label">Amount (USDC)</label>
              {balance && maxDeposit > 0 && (
                <button
                  type="button"
                  className="deposit-amount-max"
                  onClick={() => setAmount(maxDeposit.toString())}
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
                You can deposit up to ${formatUsd(maxDeposit)} more (credit limit ${formatUsd(creditLimit)})
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
            disabled={step !== 'idle' || !isValidAmount || !config || isSwitchingChain || customTargetInvalid || !depositTarget}
          >
            {isSwitchingChain ? `Switching to ${targetChainName}...` :
             wrongChain ? `Switch to ${targetChainName}` :
             step === 'approving' ? 'Approving USDC...' :
             step === 'depositing' ? 'Depositing...' :
             'Deposit USDC'}
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
