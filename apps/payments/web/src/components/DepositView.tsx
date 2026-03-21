import { useState, useCallback } from 'react';
import type { PaymentConfig } from '../types';
import './DepositView.scss';

interface DepositViewProps {
  config: PaymentConfig | null;
  buyerEvmAddress: string | null;
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

export function DepositView({ config, buyerEvmAddress, onDeposited }: DepositViewProps) {
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
            <span className="deposit-method-desc">Visa, Mastercard, etc.</span>
          </button>
        </div>

        {method === 'crypto' ? (
          <CryptoDeposit config={config} onDeposited={onDeposited} />
        ) : (
          <CardDeposit config={config} buyerEvmAddress={buyerEvmAddress} onDeposited={onDeposited} />
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

/* ── Credit Card Deposit (Transak One) ── */

const TRANSAK_API_KEY = '0bb5929f-38a6-4f2b-99e8-c46defc6d854';
const TRANSAK_ENV = 'STAGING'; // Change to 'PRODUCTION' when live
const TRANSAK_WIDGET_URL = 'https://global-stg.transak.com'; // staging; production: https://global.transak.com

/**
 * Encode depositFor(address,uint256) calldata.
 * Function selector: keccak256("depositFor(address,uint256)") = first 4 bytes
 * We compute it manually to avoid importing ethers just for this.
 */
function encodeDepositForCalldata(buyerAddress: string, amountBaseUnits: string): string {
  // depositFor(address,uint256) selector
  const selector = '0x2f4f21e2'; // keccak256("depositFor(address,uint256)")[:4]
  // Pad address to 32 bytes (remove 0x, pad left with zeros)
  const addressPadded = buyerAddress.slice(2).toLowerCase().padStart(64, '0');
  // Pad amount to 32 bytes (convert to hex, pad left)
  const amountHex = BigInt(amountBaseUnits).toString(16).padStart(64, '0');
  return selector + addressPadded + amountHex;
}

function CardDeposit({ config, buyerEvmAddress, onDeposited }: {
  config: PaymentConfig | null;
  buyerEvmAddress: string | null;
  onDeposited: () => void;
}) {
  const [amount, setAmount] = useState('10');
  const [loading, setLoading] = useState(false);

  const handlePayWithCard = useCallback(async () => {
    if (!config || !buyerEvmAddress || !amount || parseFloat(amount) <= 0) return;

    setLoading(true);

    try {
      const { Transak } = await import('@transak/transak-sdk');

      const amountBaseUnits = (parseFloat(amount) * 1_000_000).toFixed(0);
      const calldata = encodeDepositForCalldata(buyerEvmAddress, amountBaseUnits);

      const baseUrl = TRANSAK_ENV === 'STAGING'
        ? 'https://global-stg.transak.com'
        : 'https://global.transak.com';

      // Build full Transak One widget URL with all params
      const queryParams = new URLSearchParams({
        apiKey: TRANSAK_API_KEY,
        referrerDomain: window.location.origin,
        cryptoCurrencyCode: 'USDC',
        network: 'base',
        walletAddress: buyerEvmAddress,
        fiatAmount: amount,
        fiatCurrency: 'USD',
        disableWalletAddressForm: 'true',
        smartContractAddress: config.escrowContractAddress,
        calldata,
        estimatedGasLimit: '150000',
        isTransakOne: 'true',
      });

      const widgetUrl = `${baseUrl}?${queryParams.toString()}`;

      const transak = new Transak({
        widgetUrl,
        referrer: window.location.origin,
      } as Record<string, unknown>);

      transak.init();

      // SDK v4 uses static event listeners
      Transak.on('TRANSAK_ORDER_SUCCESSFUL', () => {
        transak.close();
        setLoading(false);
        onDeposited();
      });

      Transak.on('TRANSAK_ORDER_FAILED', () => {
        transak.close();
        setLoading(false);
      });

      Transak.on('TRANSAK_WIDGET_CLOSE', () => {
        setLoading(false);
      });
    } catch (err) {
      console.error('[transak] Failed to open:', err);
      setLoading(false);
    }
  }, [config, buyerEvmAddress, amount, onDeposited]);

  return (
    <div className="deposit-form">
      <div className="input-group">
        <label className="input-label">Amount (USD)</label>
        <input
          className="input-field"
          type="number"
          min="10"
          step="1"
          placeholder="10"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <span className="hint">Minimum: $10. Paid via credit card, deposited as USDC to your escrow.</span>
      </div>

      <button
        className="btn-primary"
        onClick={handlePayWithCard}
        disabled={loading || !amount || parseFloat(amount) < 10 || !buyerEvmAddress}
      >
        {loading ? 'Opening checkout...' : 'Pay with Credit Card'}
      </button>

      {!buyerEvmAddress && (
        <span className="hint" style={{ textAlign: 'center', display: 'block' }}>
          Identity not loaded — restart the desktop app.
        </span>
      )}
    </div>
  );
}
