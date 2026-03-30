import { useState, useCallback, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { parseUnits } from 'viem';
import type { PaymentConfig } from '../types';
import './DepositView.scss';

interface DepositViewProps {
  config: PaymentConfig | null;
  buyerAddress: string | null;
  onDeposited: () => void;
}

const DEPOSITS_ABI = [
  {
    name: 'depositFor',
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
] as const;

type DepositMethod = 'crypto' | 'card';

export function DepositView({ config, buyerAddress, onDeposited }: DepositViewProps) {
  const [method, setMethod] = useState<DepositMethod>('crypto');

  return (
    <div className="deposit">
      <div className="card">
        <div className="card-section-title">Deposit USDC</div>

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
          <CryptoDeposit config={config} buyerAddress={buyerAddress} onDeposited={onDeposited} />
        ) : (
          <CardDepositPlaceholder />
        )}
      </div>
    </div>
  );
}

/* ── Crypto Deposit (wagmi + RainbowKit) ── */

function CryptoDeposit({ config, buyerAddress, onDeposited }: {
  config: PaymentConfig | null;
  buyerAddress: string | null;
  onDeposited: () => void;
}) {
  const { address, isConnected, chain } = useAccount();
  const [amount, setAmount] = useState('10');
  const [step, setStep] = useState<'idle' | 'approving' | 'depositing' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const expectedChainId = config?.evmChainId;
  const wrongChain = isConnected && chain && expectedChainId && chain.id !== expectedChainId;
  const depositTarget = buyerAddress ?? address; // Use identity address if available, fallback to wallet

  // Step 1: Approve USDC
  const {
    writeContract: writeApprove,
    data: approveTxHash,
    reset: resetApprove,
  } = useWriteContract();

  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
  });

  // Step 2: Deposit
  const {
    writeContract: writeDeposit,
    data: depositTxHash,
    reset: resetDeposit,
  } = useWriteContract();

  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  });

  // When approve confirms, trigger deposit
  useEffect(() => {
    if (approveConfirmed && step === 'approving' && config && depositTarget) {
      setStep('depositing');
      const usdcAmount = parseUnits(amount, 6);
      writeDeposit({
        address: config.depositsContractAddress as `0x${string}`,
        abi: DEPOSITS_ABI,
        functionName: 'depositFor',
        args: [depositTarget as `0x${string}`, usdcAmount],
      }, {
        onError: (err) => {
          setStep('idle');
          setError(err.message.split('\n')[0] ?? err.message);
        },
      });
    }
  }, [approveConfirmed, step, config, depositTarget, amount, writeDeposit]);

  // When deposit confirms, show success
  useEffect(() => {
    if (depositConfirmed && step === 'depositing') {
      setStep('done');
      onDeposited();
    }
  }, [depositConfirmed, step, onDeposited]);

  const handleDeposit = useCallback(() => {
    if (!address || !amount || parseFloat(amount) <= 0 || !config || !depositTarget) return;

    setError(null);
    setStep('approving');
    resetApprove();
    resetDeposit();

    const usdcAmount = parseUnits(amount, 6);

    writeApprove({
      address: config.usdcContractAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [config.depositsContractAddress as `0x${string}`, usdcAmount],
    }, {
      onError: (err) => {
        setStep('idle');
        setError(err.message.split('\n')[0] ?? err.message);
      },
    });
  }, [address, amount, config, depositTarget, writeApprove, resetApprove, resetDeposit]);

  const resetForm = useCallback(() => {
    setStep('idle');
    setError(null);
    setAmount('10');
    resetApprove();
    resetDeposit();
  }, [resetApprove, resetDeposit]);

  return (
    <div className="deposit-form">
      {!isConnected ? (
        <div className="deposit-connect-wrapper">
          <ConnectButton />
        </div>
      ) : wrongChain ? (
        <div className="deposit-wrong-chain">
          <div className="deposit-wrong-chain-text">
            Please switch to the correct network in your wallet.
          </div>
          <ConnectButton />
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
          {depositTarget && depositTarget !== address && (
            <div className="deposit-target-info">
              <span className="deposit-target-label">Depositing for</span>
              <span className="deposit-target-addr">{depositTarget.slice(0, 6)}...{depositTarget.slice(-4)}</span>
            </div>
          )}

          <div className="deposit-connected">
            <div className="deposit-connected-dot" />
            <span className="deposit-connected-addr">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
            <span className="deposit-connected-label">Connected</span>
          </div>

          <div className="input-group">
            <label className="input-label">Amount (USDC)</label>
            <input
              className="input-field"
              type="number"
              min="0"
              step="0.01"
              placeholder="10.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={step !== 'idle'}
            />
            <span className="hint">Minimum first deposit: 10 USDC</span>
          </div>

          <button
            className="btn-primary"
            onClick={handleDeposit}
            disabled={step !== 'idle' || !amount || parseFloat(amount) <= 0 || !config}
          >
            {step === 'approving' ? 'Approving USDC...' :
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
