import { useState, useCallback } from 'react';
import type { PaymentConfig } from '../types';
import './DepositView.scss';

interface DepositViewProps {
  config: PaymentConfig | null;
  onDeposited: () => void;
}

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = '0x2105';

const ESCROW_ABI = [
  'function deposit(uint256 amount) external',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
];

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

/* ── Crypto Deposit ── */

function CryptoDeposit({ config, onDeposited }: { config: PaymentConfig | null; onDeposited: () => void }) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const connectWallet = useCallback(async () => {
    const ethereum = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!ethereum) {
      setStatus({ type: 'error', message: 'No wallet detected. Install MetaMask or another Web3 wallet.' });
      return;
    }

    try {
      setLoading(true);
      setStatus(null);

      const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[];
      if (!accounts || accounts.length === 0) {
        setStatus({ type: 'error', message: 'No accounts found.' });
        return;
      }

      const chainId = await ethereum.request({ method: 'eth_chainId' }) as string;
      if (parseInt(chainId, 16) !== BASE_CHAIN_ID) {
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: BASE_CHAIN_ID_HEX }],
          });
        } catch {
          setStatus({ type: 'error', message: 'Please switch to Base network in your wallet.' });
          return;
        }
      }

      setWalletAddress(accounts[0] ?? null);
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDeposit = useCallback(async () => {
    if (!walletAddress || !amount || parseFloat(amount) <= 0 || !config) return;

    const ethereum = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!ethereum) return;

    setLoading(true);
    setStatus(null);

    try {
      const { BrowserProvider, Contract, parseUnits } = await import('ethers');
      const provider = new BrowserProvider(ethereum as never);
      const signer = await provider.getSigner();
      const usdcAmount = parseUnits(amount, 6);

      setStep('Approving USDC spend...');
      const usdc = new Contract(config.usdcContractAddress, ERC20_ABI, signer);
      const approveTx = await usdc.getFunction('approve')(config.escrowContractAddress, usdcAmount);
      const approveReceipt = await approveTx.wait();
      if (!approveReceipt) throw new Error('Approval transaction was dropped or replaced');

      setStep('Depositing to escrow...');
      const escrow = new Contract(config.escrowContractAddress, ESCROW_ABI, signer);
      const depositTx = await escrow.getFunction('deposit')(usdcAmount);
      const receipt = await depositTx.wait();
      if (!receipt) throw new Error('Deposit transaction was dropped or replaced');

      setStep(null);
      setStatus({ type: 'success', message: `Deposit confirmed: ${receipt.hash}` });
      setAmount('');
      onDeposited();
    } catch (err) {
      setStep(null);
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [walletAddress, amount, config, onDeposited]);

  return (
    <div className="deposit-form">
      {!walletAddress ? (
        <button className="btn-primary" onClick={connectWallet} disabled={loading}>
          {loading ? 'Connecting...' : 'Connect Wallet'}
        </button>
      ) : (
        <>
          <div className="deposit-connected">
            <div className="deposit-connected-dot" />
            <span className="deposit-connected-addr">{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
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
              disabled={loading}
            />
            <span className="hint">Minimum first deposit: 10 USDC</span>
          </div>

          <button
            className="btn-primary"
            onClick={handleDeposit}
            disabled={loading || !amount || parseFloat(amount) <= 0 || !config}
          >
            {step || (loading ? 'Processing...' : 'Deposit USDC')}
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
