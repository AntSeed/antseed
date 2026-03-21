import { useState, useEffect, useCallback } from 'react';
import type { BalanceData, PaymentConfig } from './types';
import { getBalance, getConfig } from './api';
import { BalanceView } from './components/BalanceView';
import { DepositView } from './components/DepositView';
import { WithdrawView } from './components/WithdrawView';

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function AntIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 9.625C14.9665 9.625 15.75 8.763 15.75 7.7C15.75 6.637 14.9665 5.775 14 5.775C13.0335 5.775 12.25 6.637 12.25 7.7C12.25 8.763 13.0335 9.625 14 9.625Z" fill="currentColor"/>
      <path d="M14 15.4C15.353 15.4 16.45 14.146 16.45 12.6C16.45 11.054 15.353 9.8 14 9.8C12.647 9.8 11.55 11.054 11.55 12.6C11.55 14.146 12.647 15.4 14 15.4Z" fill="currentColor"/>
      <path d="M14 23.45C15.74 23.45 17.15 21.57 17.15 19.25C17.15 16.93 15.74 15.05 14 15.05C12.26 15.05 10.85 16.93 10.85 19.25C10.85 21.57 12.26 23.45 14 23.45Z" fill="currentColor"/>
      <path opacity="0.6" d="M12.95 5.95L9.8 2.1" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round"/>
      <path opacity="0.6" d="M15.05 5.95L18.2 2.1" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round"/>
      <circle cx="9.8" cy="2.1" r="0.875" fill="currentColor"/>
      <circle cx="18.2" cy="2.1" r="0.875" fill="currentColor"/>
      <path opacity="0.4" d="M12.25 11.2L6.125 7.7" stroke="currentColor" strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.4" d="M15.75 11.2L21.875 7.7" stroke="currentColor" strokeWidth="0.52" strokeLinecap="round"/>
      <circle cx="6.3" cy="7.7" r="0.875" fill="currentColor"/>
      <circle cx="21.7" cy="7.7" r="0.875" fill="currentColor"/>
    </svg>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'deposit' | 'withdraw'>('deposit');
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [config, setConfig] = useState<PaymentConfig | null>(null);

  const refreshBalance = useCallback(async () => {
    try {
      const data = await getBalance();
      setBalance(data);
    } catch {
      // Balance not available yet — that's OK, show deposit UI anyway
    }
  }, []);

  useEffect(() => {
    void refreshBalance();
    void getConfig().then(setConfig).catch(() => {});
  }, [refreshBalance]);

  const available = balance ? parseFloat(balance.available) : 0;
  const reserved = balance ? parseFloat(balance.reserved) : 0;
  const creditLimit = balance ? parseFloat(balance.creditLimit) : 0;
  const hasBalance = balance !== null;

  return (
    <div className="portal">
      {/* ── Header ── */}
      <header className="portal-header">
        <div className="portal-brand">
          <AntIcon size={22} />
          <span className="portal-title">AntSeed</span>
        </div>
        <div className="portal-header-right">
          <div className="portal-network-badge">
            <span className="portal-network-dot" />
            Base
          </div>
          {balance?.evmAddress && (
            <span className="portal-address" title={balance.evmAddress}>
              {truncateAddress(balance.evmAddress)}
            </span>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="portal-body">
        {/* ── Balance bar (shows zeroes if no balance yet) ── */}
        <div className="balance-bar">
          <div className="balance-bar-item">
            <span className="balance-bar-label">Available</span>
            <span className="balance-bar-value balance-bar-value--accent">
              ${available.toFixed(2)}
            </span>
          </div>
          <div className="balance-bar-item">
            <span className="balance-bar-label">Reserved</span>
            <span className="balance-bar-value">${reserved.toFixed(2)}</span>
          </div>
          <div className="balance-bar-item">
            <span className="balance-bar-label">Credit Limit</span>
            <span className="balance-bar-value">${creditLimit.toFixed(2)}</span>
          </div>
        </div>

        {/* ── Tabs ── */}
        <nav className="tabs">
          <button
            className={`tab ${activeTab === 'overview' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            className={`tab ${activeTab === 'deposit' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('deposit')}
          >
            Deposit
          </button>
          <button
            className={`tab ${activeTab === 'withdraw' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('withdraw')}
          >
            Withdraw
          </button>
        </nav>

        {/* ── Tab content ── */}
        <main>
          {activeTab === 'overview' && <BalanceView balance={balance} />}
          {activeTab === 'deposit' && <DepositView config={config} onDeposited={refreshBalance} />}
          {activeTab === 'withdraw' && <WithdrawView balance={balance} onAction={refreshBalance} />}
        </main>
      </div>

      {/* ── Footer ── */}
      <footer className="portal-footer">
        <span className="portal-footer-left">AntSeed Payments</span>
        <div className="portal-footer-right">
          <a href="https://antseed.com" target="_blank" rel="noopener noreferrer" className="portal-footer-link">antseed.com</a>
          <a href="https://docs.antseed.com" target="_blank" rel="noopener noreferrer" className="portal-footer-link">Docs</a>
        </div>
      </footer>
    </div>
  );
}
