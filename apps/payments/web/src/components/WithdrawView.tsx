import { useState } from 'react';
import type { BalanceData } from '../types';
import { requestWithdrawal, executeWithdrawal, cancelWithdrawal } from '../api';
import './WithdrawView.scss';

interface WithdrawViewProps {
  balance: BalanceData | null;
  onAction: () => void;
}

export function WithdrawView({ balance, onAction }: WithdrawViewProps) {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  if (!balance) {
    return (
      <div className="card">
        <div className="card-title">Withdraw</div>
        <p className="hint">Loading balance...</p>
      </div>
    );
  }

  const pendingAmount = parseFloat(balance.pendingWithdrawal);
  const hasPending = pendingAmount > 0;
  const availableAmount = parseFloat(balance.available);

  async function handleRequest() {
    if (!amount || parseFloat(amount) <= 0) return;
    setLoading(true);
    setStatus(null);
    try {
      const result = await requestWithdrawal(amount);
      if (result.ok) {
        setStatus({ type: 'success', message: `Withdrawal requested. TX: ${result.txHash ?? 'pending'}` });
        setAmount('');
        onAction();
      } else {
        setStatus({ type: 'error', message: result.error || 'Request failed' });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }

  async function handleExecute() {
    setLoading(true);
    setStatus(null);
    try {
      const result = await executeWithdrawal();
      if (result.ok) {
        setStatus({ type: 'success', message: `Withdrawal executed. TX: ${result.txHash ?? 'confirmed'}` });
        onAction();
      } else {
        setStatus({ type: 'error', message: result.error || 'Execution failed' });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    setLoading(true);
    setStatus(null);
    try {
      const result = await cancelWithdrawal();
      if (result.ok) {
        setStatus({ type: 'success', message: 'Withdrawal cancelled.' });
        onAction();
      } else {
        setStatus({ type: 'error', message: result.error || 'Cancel failed' });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <div className="card-title">Withdraw</div>

      {hasPending ? (
        <div className="withdraw-pending">
          <div className="withdraw-pending-info">
            <span className="withdraw-pending-label">Pending Withdrawal</span>
            <span className="withdraw-pending-amount">${pendingAmount.toFixed(2)}</span>
          </div>
          <p className="hint">
            Withdrawals have a 48-hour delay. After the delay passes, click "Execute" to complete.
          </p>
          <div className="withdraw-actions">
            <button className="btn-primary" onClick={handleExecute} disabled={loading}>
              {loading ? 'Processing...' : 'Execute Withdrawal'}
            </button>
            <button className="btn-danger" onClick={handleCancel} disabled={loading}>
              {loading ? 'Processing...' : 'Cancel Withdrawal'}
            </button>
          </div>
        </div>
      ) : (
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
            onClick={handleRequest}
            disabled={loading || !amount || parseFloat(amount) <= 0}
          >
            {loading ? 'Processing...' : 'Request Withdrawal'}
          </button>
        </div>
      )}

      {status && (
        <p className={`status-msg ${status.type === 'success' ? 'status-success' : 'status-error'}`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
