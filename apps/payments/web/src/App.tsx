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

export function App() {
  const [activeTab, setActiveTab] = useState<'balance' | 'deposit' | 'withdraw'>('deposit');
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshBalance = useCallback(async () => {
    try {
      const data = await getBalance();
      setBalance(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshBalance();
    void getConfig().then(setConfig).catch(() => {});
  }, [refreshBalance]);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">AntSeed Payments</h1>
        {balance?.evmAddress && (
          <span className="evm-address" title={balance.evmAddress}>
            {truncateAddress(balance.evmAddress)}
          </span>
        )}
      </header>

      {error && <div className="app-error">{error}</div>}

      <nav className="tabs">
        <button
          className={`tab ${activeTab === 'balance' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('balance')}
        >
          Balance
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

      <main className="app-main">
        {activeTab === 'balance' && <BalanceView balance={balance} />}
        {activeTab === 'deposit' && <DepositView config={config} onDeposited={refreshBalance} />}
        {activeTab === 'withdraw' && <WithdrawView balance={balance} onAction={refreshBalance} />}
      </main>
    </div>
  );
}
