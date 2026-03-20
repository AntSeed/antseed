import type { BalanceData } from '../types';
import './BalanceView.scss';

interface BalanceViewProps {
  balance: BalanceData | null;
}

function BalanceRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="balance-row">
      <span className="balance-label">{label}</span>
      <span className={`balance-value${highlight ? ' balance-highlight' : ''}`}>{value}</span>
    </div>
  );
}

export function BalanceView({ balance }: BalanceViewProps) {
  if (!balance) {
    return (
      <div className="card">
        <div className="card-title">Balance</div>
        <p className="hint">Loading balance...</p>
      </div>
    );
  }

  const available = parseFloat(balance.available);
  const displayAvailable = `$${available.toFixed(2)}`;

  return (
    <div className="card">
      <div className="balance-hero">
        <span className="balance-hero-label">Available Balance</span>
        <span className="balance-hero-value">{displayAvailable}</span>
      </div>
      <div className="balance-details">
        <BalanceRow label="Reserved" value={`$${parseFloat(balance.reserved).toFixed(2)}`} />
        <BalanceRow label="Pending Withdrawal" value={`$${parseFloat(balance.pendingWithdrawal).toFixed(2)}`} />
        <BalanceRow label="Total Deposited" value={`$${parseFloat(balance.total).toFixed(2)}`} highlight />
        <BalanceRow label="Credit Limit" value={`$${parseFloat(balance.creditLimit).toFixed(2)}`} />
      </div>
    </div>
  );
}
