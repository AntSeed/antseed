import type { BalanceData } from '../types';
import './BalanceView.scss';

interface BalanceViewProps {
  balance: BalanceData | null;
}

export function BalanceView({ balance }: BalanceViewProps) {
  if (!balance) {
    return (
      <div className="card">
        <div className="card-section-title">Account Details</div>
        <div className="overview-empty">
          <div className="overview-empty-title">No balance data</div>
          <div className="overview-empty-desc">
            Deposit USDC to get started. Your balance will appear here.
          </div>
        </div>
      </div>
    );
  }

  const available = parseFloat(balance.available);
  const reserved = parseFloat(balance.reserved);
  const total = parseFloat(balance.total);
  const pending = parseFloat(balance.pendingWithdrawal);
  const limit = parseFloat(balance.creditLimit);
  const utilization = limit > 0 ? ((total / limit) * 100) : 0;

  return (
    <div className="overview">
      <div className="card">
        <div className="card-section-title">Account Details</div>

        <div className="overview-rows">
          <div className="overview-row">
            <span className="overview-row-label">Total Deposited</span>
            <span className="overview-row-value">${total.toFixed(2)}</span>
          </div>
          <div className="overview-row">
            <span className="overview-row-label">Available</span>
            <span className="overview-row-value overview-row-value--accent">${available.toFixed(2)}</span>
          </div>
          <div className="overview-row">
            <span className="overview-row-label">Reserved in Sessions</span>
            <span className="overview-row-value">${reserved.toFixed(2)}</span>
          </div>
          {pending > 0 && (
            <div className="overview-row">
              <span className="overview-row-label overview-row-label--amber">Pending Withdrawal</span>
              <span className="overview-row-value overview-row-value--amber">${pending.toFixed(2)}</span>
            </div>
          )}
        </div>

        <div className="overview-limit">
          <div className="overview-limit-header">
            <span className="overview-limit-label">Credit Limit</span>
            <span className="overview-limit-value">${limit.toFixed(2)}</span>
          </div>
          <div className="overview-limit-bar">
            <div
              className="overview-limit-bar-fill"
              style={{ width: `${Math.min(utilization, 100)}%` }}
            />
          </div>
          <span className="overview-limit-hint">
            {utilization.toFixed(0)}% utilized — limit grows with network activity
          </span>
        </div>
      </div>

      <div className="overview-address-card">
        <span className="overview-address-label">Escrow Address</span>
        <span className="overview-address-value">{balance.evmAddress}</span>
      </div>
    </div>
  );
}
