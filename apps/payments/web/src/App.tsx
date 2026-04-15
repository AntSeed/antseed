import { useState, useEffect, useCallback } from 'react';
import type { BalanceData, PaymentConfig } from './types';
import { getBalance, getConfig } from './api';
import { Sidebar, type TabId } from './layout/Sidebar';
import { TopBar } from './layout/TopBar';
import { WalletDrawer } from './layout/WalletDrawer';
import { EmptyStateOverlay } from './layout/EmptyStateOverlay';
import { LoaderOverlay } from './layout/LoaderOverlay';
import { ActionModal } from './layout/ActionModal';
import { DepositView } from './components/DepositView';
import { WithdrawView } from './components/WithdrawView';
import { DashboardView } from './views/DashboardView';
import { EmissionsView } from './views/EmissionsView';
import { AnalyticsView } from './views/AnalyticsView';
import { ChannelsView } from './components/ChannelsView';

const VALID_TABS = new Set<TabId>(['dashboard', 'channels', 'emissions', 'analytics']);

function parseTabFromUrl(): TabId {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (!raw) return 'dashboard';
  // Legacy compat: the old deposits tab no longer exists; fall through to dashboard.
  if (raw === 'deposit' || raw === 'deposits') return 'dashboard';
  return VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'dashboard';
}

function writeTabToUrl(tab: TabId) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history.replaceState({}, '', url.toString());
}

export function App() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(() => parseTabFromUrl());
  const [walletDrawerOpen, setWalletDrawerOpen] = useState(false);
  const [actionModal, setActionModal] = useState<'deposit' | 'withdraw' | null>(null);
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('antseed-payments-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('antseed-payments-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const fetchBalance = useCallback(async () => {
    try {
      const data = await getBalance();
      setBalance(data);
      setBalanceLoaded(true);
    } catch {
      // Balance not available yet — keep loading state until a fetch succeeds.
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    await fetchBalance();
    setTimeout(fetchBalance, 3000);
  }, [fetchBalance]);

  useEffect(() => {
    void fetchBalance();
    void getConfig().then(setConfig).catch(() => {});
  }, [fetchBalance]);

  const handleSelectTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  const buyerEvmAddress = config?.evmAddress ?? balance?.evmAddress ?? null;
  // Loading = first balance fetch hasn't completed yet.
  // Empty buyer = loaded, but nothing deposited and nothing reserved.
  const isLoading = !balanceLoaded;
  const isEmptyBuyer =
    balanceLoaded &&
    balance !== null &&
    parseFloat(balance.total) === 0 &&
    parseFloat(balance.reserved) === 0;
  const shellBlurred = isLoading || isEmptyBuyer;

  return (
    <>
    <div className={`dash-shell${shellBlurred ? ' dash-shell--blurred' : ''}`}>
      <Sidebar
        activeTab={activeTab}
        onSelect={handleSelectTab}
        isDark={isDark}
        onToggleTheme={() => setIsDark((d) => !d)}
      />
      <div className="dash-main">
        <TopBar
          activeTab={activeTab}
          balance={balance}
          onOpenWallet={() => setWalletDrawerOpen(true)}
        />
        <main className="dash-content">
          {activeTab === 'dashboard' && <DashboardView config={config} />}
          {activeTab === 'channels'  && <ChannelsView  config={config} />}
          {activeTab === 'emissions' && <EmissionsView config={config} />}
          {activeTab === 'analytics' && <AnalyticsView config={config} />}
        </main>
      </div>
      <WalletDrawer
        isOpen={walletDrawerOpen}
        onClose={() => setWalletDrawerOpen(false)}
        balance={balance}
        config={config}
        buyerEvmAddress={buyerEvmAddress}
        onOpenDeposit={() => setActionModal('deposit')}
        onOpenWithdraw={() => setActionModal('withdraw')}
      />
    </div>
    <LoaderOverlay isVisible={isLoading} />
    <EmptyStateOverlay
      isVisible={isEmptyBuyer}
      config={config}
      balance={balance}
      buyerAddress={buyerEvmAddress}
      onDeposited={refreshBalance}
    />
    <ActionModal
      isOpen={actionModal === 'deposit'}
      onClose={() => setActionModal(null)}
      title="Deposit USDC"
      subtitle="Add funds to your AntSeed account."
    >
      <DepositView
        config={config}
        balance={balance}
        buyerAddress={buyerEvmAddress}
        onDeposited={refreshBalance}
      />
    </ActionModal>
    <ActionModal
      isOpen={actionModal === 'withdraw'}
      onClose={() => setActionModal(null)}
      title="Withdraw USDC"
      subtitle="Send funds to your authorized wallet."
    >
      <WithdrawView balance={balance} onAction={refreshBalance} />
    </ActionModal>
    </>
  );
}
