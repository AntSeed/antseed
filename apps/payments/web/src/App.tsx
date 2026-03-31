import { useState, useEffect, useCallback } from 'react';
import type { BalanceData, PaymentConfig } from './types';
import { getBalance, getConfig } from './api';
import { DepositView } from './components/DepositView';
import { WithdrawView } from './components/WithdrawView';
import { ChannelsView } from './components/ChannelsView';

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

function ThemeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <button className="theme-toggle" onClick={onToggle} title={isDark ? 'Switch to light' : 'Switch to dark'}>
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2"/><path d="M8 2V3.5M8 12.5V14M2 8H3.5M12.5 8H14M3.8 3.8L4.8 4.8M11.2 11.2L12.2 12.2M3.8 12.2L4.8 11.2M11.2 4.8L12.2 3.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 10A5.5 5.5 0 016 2.5 5.5 5.5 0 108 13.5a5.5 5.5 0 005.5-3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
      )}
    </button>
  );
}

export function App() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [activeTab, setActiveTab] = useState<'deposit' | 'channels'>(() => {
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    return urlTab === 'channels' ? 'channels' : 'deposit';
  });
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('antseed-payments-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('antseed-payments-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const refreshBalance = useCallback(async () => {
    try {
      const data = await getBalance();
      setBalance(data);
    } catch {
      // Balance not available yet
    }
  }, []);

  useEffect(() => {
    void refreshBalance();
    void getConfig().then(setConfig).catch(() => {});
  }, [refreshBalance]);

  const available = balance ? parseFloat(balance.available) : 0;
  const reserved = balance ? parseFloat(balance.reserved) : 0;
  const creditLimit = balance ? parseFloat(balance.creditLimit) : 0;
  const buyerEvmAddress = config?.evmAddress ?? balance?.evmAddress ?? null;

  return (
    <div className="portal-page">
      <div className="portal-box">
        {/* ── Header ── */}
        <div className="portal-header">
          <div className="portal-brand">
            <AntIcon size={20} />
            <span className="portal-title">AntSeed</span>
          </div>
          <div className="portal-header-right">
            <ThemeToggle isDark={isDark} onToggle={() => setIsDark(d => !d)} />
            <div className="portal-network">
              <span className="portal-network-dot" />
              Base
            </div>
          </div>
        </div>

        {/* ── Balance bar ── */}
        <div className="balance-bar">
          <div className="balance-bar-item">
            <span className="balance-bar-label">Available</span>
            <span className="balance-bar-value balance-bar-value--accent">${available.toFixed(2)}</span>
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
        <div className="tabs">
          <button
            className={`tab${activeTab === 'deposit' ? ' tab-active' : ''}`}
            onClick={() => setActiveTab('deposit')}
          >
            Deposit
          </button>
          <button
            className={`tab${activeTab === 'channels' ? ' tab-active' : ''}`}
            onClick={() => setActiveTab('channels')}
          >
            Channels
          </button>
        </div>

        {/* ── Tab content ── */}
        <div className="portal-section">
          {activeTab === 'deposit' ? (
            <DepositView config={config} buyerAddress={config?.evmAddress ?? null} onDeposited={refreshBalance} />
          ) : (
            <ChannelsView config={config} />
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="portal-footer">
        <span>AntSeed Payments</span>
        <div className="portal-footer-links">
          <a href="https://antseed.com" target="_blank" rel="noopener noreferrer">antseed.com</a>
          <a href="https://docs.antseed.com" target="_blank" rel="noopener noreferrer">Docs</a>
        </div>
      </div>
    </div>
  );
}
