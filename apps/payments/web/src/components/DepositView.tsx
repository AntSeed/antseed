import { useState, useCallback } from 'react';
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
  onDeposited: () => void;
}

const ESCROW_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
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

export function DepositView({ config, onDeposited }: DepositViewProps) {
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
          <CryptoDeposit config={config} onDeposited={onDeposited} />
        ) : (
          <CardDepositPlaceholder />
        )}
      </div>
    </div>
  );
}

/* ── Crypto Deposit (wagmi + RainbowKit) ── */

function CryptoDeposit({ config, onDeposited }: { config: PaymentConfig | null; onDeposited: () => void }) {
  const { address, isConnected, chain } = useAccount();
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'idle' | 'approving' | 'depositing'>('idle');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Approve USDC spend
  const { writeContract: writeApprove, data: approveTxHash } = useWriteContract();
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
  });

  // Deposit to escrow
  const { writeContract: writeDeposit, data: depositTxHash } = useWriteContract();
  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  });

  // Check if user is on the correct chain
  const expectedChainId = config?.evmChainId;
  const wrongChain = isConnected && chain && expectedChainId && chain.id !== expectedChainId;

  const handleDeposit = useCallback(async () => {
    if (!address || !amount || parseFloat(amount) <= 0 || !config) return;

    setStatus(null);
    const usdcAmount = parseUnits(amount, 6);

    try {
      // Step 1: Approve
      setStep('approving');
      writeApprove({
        address: config.usdcContractAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [config.escrowContractAddress as `0x${string}`, usdcAmount],
      }, {
        onSuccess: () => {
          // Step 2: Deposit (after approve tx is submitted)
          setStep('depositing');
          writeDeposit({
            address: config.escrowContractAddress as `0x${string}`,
            abi: ESCROW_ABI,
            functionName: 'deposit',
            args: [usdcAmount],
          }, {
            onSuccess: () => {
              setStep('idle');
              setStatus({ type: 'success', message: 'Deposit submitted! Waiting for confirmation...' });
              setAmount('');
              onDeposited();
            },
            onError: (err) => {
              setStep('idle');
              setStatus({ type: 'error', message: err.message.split('\n')[0] ?? err.message });
            },
          });
        },
        onError: (err) => {
          setStep('idle');
          setStatus({ type: 'error', message: err.message.split('\n')[0] ?? err.message });
        },
      });
    } catch (err) {
      setStep('idle');
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [address, amount, config, writeApprove, writeDeposit, onDeposited]);

  // Show deposit confirmed status
  if (depositConfirmed && depositTxHash && status?.type !== 'success') {
    setStatus({ type: 'success', message: `Deposit confirmed: ${depositTxHash}` });
  }

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
      ) : (
        <>
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

      {status && (
        <div className={`status-msg ${status.type === 'success' ? 'status-success' : 'status-error'}`}>
          {status.message}
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
          Direct credit card to escrow deposits are being integrated.
          For now, use the crypto wallet option.
        </div>
      </div>
    </div>
  );
}
