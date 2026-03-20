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

type DepositTab = 'crypto' | 'card';

export function DepositView({ config, onDeposited }: DepositViewProps) {
  const [activeTab, setActiveTab] = useState<DepositTab>('crypto');

  if (!config) {
    return (
      <div className="card">
        <div className="card-title">Deposit</div>
        <p className="hint">Loading configuration...</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Deposit</div>
      <div className="deposit-tabs">
        <button
          className={`deposit-tab ${activeTab === 'crypto' ? 'deposit-tab-active' : ''}`}
          onClick={() => setActiveTab('crypto')}
        >
          Crypto
        </button>
        <button
          className={`deposit-tab ${activeTab === 'card' ? 'deposit-tab-active' : ''}`}
          onClick={() => setActiveTab('card')}
        >
          Credit Card
        </button>
      </div>

      {activeTab === 'crypto' ? (
        <CryptoDeposit config={config} onDeposited={onDeposited} />
      ) : (
        <CrossmintDeposit config={config} onDeposited={onDeposited} />
      )}
    </div>
  );
}

/* ── Crypto Deposit ─────────────────────────────────────────── */

function CryptoDeposit({ config, onDeposited }: { config: PaymentConfig; onDeposited: () => void }) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
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

      // Request accounts
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[];
      if (!accounts || accounts.length === 0) {
        setStatus({ type: 'error', message: 'No accounts found.' });
        return;
      }

      // Check chain
      const chainId = await ethereum.request({ method: 'eth_chainId' }) as string;
      if (parseInt(chainId, 16) !== BASE_CHAIN_ID) {
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: BASE_CHAIN_ID_HEX }],
          });
        } catch {
          setStatus({ type: 'error', message: 'Please switch to Base network (chainId 8453) in your wallet.' });
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
    if (!walletAddress || !amount || parseFloat(amount) <= 0) return;

    const ethereum = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!ethereum) return;

    setLoading(true);
    setStatus(null);

    try {
      const { BrowserProvider, Contract, parseUnits } = await import('ethers');
      const provider = new BrowserProvider(ethereum as never);
      const signer = await provider.getSigner();

      const usdcAmount = parseUnits(amount, 6);

      // Step 1: Approve USDC
      setStatus({ type: 'success', message: 'Step 1/2: Approving USDC...' });
      const usdc = new Contract(config.usdcContractAddress, ERC20_ABI, signer);
      const approveTx = await usdc.getFunction('approve')(config.escrowContractAddress, usdcAmount);
      const approveReceipt = await approveTx.wait();
      if (!approveReceipt) throw new Error('Approval transaction was dropped or replaced');

      // Step 2: Deposit
      setStatus({ type: 'success', message: 'Step 2/2: Depositing...' });
      const escrow = new Contract(config.escrowContractAddress, ESCROW_ABI, signer);
      const depositTx = await escrow.getFunction('deposit')(usdcAmount);
      const receipt = await depositTx.wait();
      if (!receipt) throw new Error('Deposit transaction was dropped or replaced');

      setStatus({ type: 'success', message: `Deposit successful! TX: ${receipt.hash}` });
      setAmount('');
      onDeposited();
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [walletAddress, amount, config, onDeposited]);

  return (
    <div className="deposit-section">
      {!walletAddress ? (
        <button className="btn-primary" onClick={connectWallet} disabled={loading}>
          {loading ? 'Connecting...' : 'Connect Wallet'}
        </button>
      ) : (
        <>
          <div className="deposit-wallet-info">
            <span className="deposit-wallet-label">Connected</span>
            <span className="deposit-wallet-address">{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
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
            disabled={loading || !amount || parseFloat(amount) <= 0}
          >
            {loading ? 'Processing...' : 'Deposit'}
          </button>
        </>
      )}

      {status && (
        <p className={`status-msg ${status.type === 'success' ? 'status-success' : 'status-error'}`}>
          {status.message}
        </p>
      )}
    </div>
  );
}

/* ── Crossmint Credit Card ──────────────────────────────────── */

function CrossmintDeposit({ config, onDeposited: _onDeposited }: { config: PaymentConfig; onDeposited: () => void }) {
  if (!config.crossmintConfigured) {
    return (
      <div className="deposit-section">
        <div className="crossmint-setup">
          <h3 className="crossmint-title">Credit Card Deposits</h3>
          <p className="crossmint-desc">
            To enable credit card deposits, configure your Crossmint API key:
          </p>
          <code className="crossmint-code">ANTSEED_CROSSMINT_API_KEY=your_key</code>
          <p className="crossmint-desc">
            Crossmint's Pay API will call <code>depositFor(buyerAddress, amount)</code> on
            the escrow contract, funding your account directly from a credit card.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="deposit-section">
      <div className="crossmint-ready">
        <h3 className="crossmint-title">Deposit via Credit Card</h3>
        <p className="hint">Crossmint integration ready. Credit card checkout coming soon.</p>
      </div>
    </div>
  );
}
