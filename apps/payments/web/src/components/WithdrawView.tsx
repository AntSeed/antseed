import { useState } from 'react';
import type { BalanceData } from '../types';
import { withdraw } from '../api';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import './WithdrawView.scss';

interface WithdrawViewProps {
  balance: BalanceData | null;
  onAction: () => void;
}

export function WithdrawView({ balance, onAction }: WithdrawViewProps) {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const { requireAuthorization } = useAuthorizedWallet();

  if (!balance) {
    return (
      <div className="card">
        <div className="card-section-title">Withdraw</div>
        <div className="withdraw-loading">Loading...</div>
      </div>
    );
  }

  const availableAmount = parseFloat(balance.available);

  function handleWithdraw() {
    if (!amount || parseFloat(amount) <= 0) return;
    requireAuthorization(async () => {
      setLoading(true);
      setStatus(null);
      try {
        const result = await withdraw(amount);
        if (result.ok) {
          setStatus({ type: 'success', message: `Withdrawal complete. TX: ${result.txHash ?? 'confirmed'}` });
          setAmount('');
          onAction();
        } else {
          setStatus({ type: 'error', message: result.error || 'Withdrawal failed' });
        }
      } catch (err) {
        setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        setLoading(false);
      }
    });
  }

  return (
    <div className="withdraw">
      <div className="card">
        <div className="card-section-title">Withdraw USDC</div>
        <div className="wallet-role-hint">
          Withdrawals are sent to your authorized wallet. You'll be prompted to
          authorize one if you haven't already.
        </div>

        <div className="withdraw-request">
          <div className="input-group">
            <label className="input-label">Amount (USDC)</label>
            <input
              className="input-field"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={loading}
            />
            <span className="hint">Available: ${availableAmount.toFixed(2)} USDC</span>
          </div>

          <button
            className="btn-primary"
            onClick={handleWithdraw}
            disabled={loading || !amount || parseFloat(amount) <= 0 || parseFloat(amount) > availableAmount}
          >
            {loading ? 'Processing...' : 'Withdraw'}
          </button>
        </div>

        {status && (
          <div className={`status-msg ${status.type === 'success' ? 'status-success' : 'status-error'}`}>
            {status.message}
          </div>
        )}
      </div>
    </div>
  );
}
