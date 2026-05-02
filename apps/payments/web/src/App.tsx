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
import { DiemRewardsView } from './views/DiemRewardsView';
import { ChannelsView } from './components/ChannelsView';
import { AuthorizedWalletProvider } from './context/AuthorizedWalletContext';
import { AuthorizeWalletAlert } from './layout/AuthorizeWalletAlert';

export type OverlayPhase = 'deposit' | 'success' | null;

const VALID_TABS = new Set<TabId>(['dashboard', 'channels', 'emissions', 'diem-rewards']);

function parseTabFromUrl(): TabId {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (!raw) return 'dashboard';
  // Legacy compat: the old deposits tab no longer exists; fall through to dashboard.
  if (raw === 'deposit' || raw === 'deposits') return 'dashboard';
  return VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'dashboard';
}

function shouldOpenDepositFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action') ?? params.get('modal');
  const tab = params.get('tab');
  return action === 'deposit' || tab === 'deposit' || tab === 'deposits';
}

function writeTabToUrl(tab: TabId) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history.replaceState({}, '', url.toString());
}

function clearDepositActionFromUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('action') === 'deposit') url.searchParams.delete('action');
  if (url.searchParams.get('modal') === 'deposit') url.searchParams.delete('modal');
  window.history.replaceState({}, '', url.toString());
}

export function App() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(() => parseTabFromUrl());
  const [walletDrawerOpen, setWalletDrawerOpen] = useState(false);
  const [actionModal, setActionModal] = useState<'deposit' | 'withdraw' | null>(() => shouldOpenDepositFromUrl() ? 'deposit' : null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('antseed-payments-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    const handler = () => setSessionExpired(true);
    window.addEventListener('antseed:session-expired', handler);
    return () => window.removeEventListener('antseed:session-expired', handler);
  }, []);

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

  const openDeposit = useCallback(() => setActionModal('deposit'), []);
  const openWithdraw = useCallback(() => setActionModal('withdraw'), []);
  const closeActionModal = useCallback(() => {
    setActionModal(null);
    clearDepositActionFromUrl();
  }, []);

  const buyerEvmAddress = config?.evmAddress ?? balance?.evmAddress ?? null;

  return (
    <AuthorizedWalletProvider config={config}>
      <AppShell
        balance={balance}
        balanceLoaded={balanceLoaded}
        config={config}
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        isDark={isDark}
        onToggleTheme={() => setIsDark((d) => !d)}
        walletDrawerOpen={walletDrawerOpen}
        onOpenWalletDrawer={() => setWalletDrawerOpen(true)}
        onCloseWalletDrawer={() => setWalletDrawerOpen(false)}
        actionModal={actionModal}
        onOpenDeposit={openDeposit}
        onOpenWithdraw={openWithdraw}
        onCloseActionModal={closeActionModal}
        buyerEvmAddress={buyerEvmAddress}
        refreshBalance={refreshBalance}
      />
      {sessionExpired && (
        <div className="session-expired-overlay" role="alert">
          <div className="session-expired-card">
            <div className="session-expired-icon">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                <circle cx="24" cy="24" r="22" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="4 3" />
                <path d="M24 14V26" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx="24" cy="33" r="1.5" fill="var(--text-muted)" />
              </svg>
            </div>
            <h2 className="session-expired-title">Session expired</h2>
            <p className="session-expired-subtitle">
              The payments server was restarted. Please reopen this portal from the desktop app or CLI to get a new session.
            </p>
          </div>
        </div>
      )}
    </AuthorizedWalletProvider>
  );
}

interface AppShellProps {
  balance: BalanceData | null;
  balanceLoaded: boolean;
  config: PaymentConfig | null;
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  isDark: boolean;
  onToggleTheme: () => void;
  walletDrawerOpen: boolean;
  onOpenWalletDrawer: () => void;
  onCloseWalletDrawer: () => void;
  actionModal: 'deposit' | 'withdraw' | null;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
  onCloseActionModal: () => void;
  buyerEvmAddress: string | null;
  refreshBalance: () => Promise<void>;
}

function AppShell({
  balance,
  balanceLoaded,
  config,
  activeTab,
  onSelectTab,
  isDark,
  onToggleTheme,
  walletDrawerOpen,
  onOpenWalletDrawer,
  onCloseWalletDrawer,
  actionModal,
  onOpenDeposit,
  onOpenWithdraw,
  onCloseActionModal,
  buyerEvmAddress,
  refreshBalance,
}: AppShellProps) {
  const [justDeposited, setJustDeposited] = useState(false);
  const [depositPromptDismissed, setDepositPromptDismissed] = useState(false);

  const isLoading = !balanceLoaded;
  const isEmptyBuyer =
    balanceLoaded &&
    balance !== null &&
    parseFloat(balance.total) === 0 &&
    parseFloat(balance.reserved) === 0;

  let overlayPhase: OverlayPhase = null;
  if (justDeposited) overlayPhase = 'success';
  else if (isEmptyBuyer && !depositPromptDismissed) overlayPhase = 'deposit';

  const shellBlurred = isLoading || overlayPhase !== null;

  const handleDeposited = useCallback(async () => {
    setJustDeposited(true);
    onCloseActionModal();
    await refreshBalance();
  }, [refreshBalance, onCloseActionModal]);

  const dismissSuccess = useCallback(() => setJustDeposited(false), []);
  const dismissDepositPrompt = useCallback(() => setDepositPromptDismissed(true), []);

  return (
    <>
      <div className={`dash-shell${shellBlurred ? ' dash-shell--blurred' : ''}`}>
        <Sidebar
          activeTab={activeTab}
          onSelect={onSelectTab}
          isDark={isDark}
          onToggleTheme={onToggleTheme}
        />
        <div className="dash-main">
          <TopBar
            activeTab={activeTab}
            balance={balance}
            onOpenWallet={onOpenWalletDrawer}
            onOpenDeposit={onOpenDeposit}
          />
          <AuthorizeWalletAlert />
          <main className="dash-content">
            {activeTab === 'dashboard' && <DashboardView config={config} />}
            {activeTab === 'channels'  && <ChannelsView  config={config} />}
            {activeTab === 'emissions' && <EmissionsView config={config} />}
            {activeTab === 'diem-rewards' && <DiemRewardsView config={config} />}
          </main>
        </div>
        <WalletDrawer
          isOpen={walletDrawerOpen}
          onClose={onCloseWalletDrawer}
          balance={balance}
          config={config}
          buyerEvmAddress={buyerEvmAddress}
          onOpenDeposit={onOpenDeposit}
          onOpenWithdraw={onOpenWithdraw}
        />
      </div>
      <LoaderOverlay isVisible={isLoading} />
      <EmptyStateOverlay
        phase={overlayPhase}
        config={config}
        balance={balance}
        buyerAddress={buyerEvmAddress}
        onDeposited={handleDeposited}
        onContinue={dismissSuccess}
        onDismissDeposit={dismissDepositPrompt}
      />
      <ActionModal
        isOpen={actionModal === 'deposit'}
        onClose={onCloseActionModal}
        title="Deposit USDC"
        subtitle="Add credits to your AntSeed account with a guided two-step flow."
        variant="deposit"
      >
        <DepositView
          config={config}
          balance={balance}
          buyerAddress={buyerEvmAddress}
          onDeposited={handleDeposited}
        />
      </ActionModal>
      <ActionModal
        isOpen={actionModal === 'withdraw'}
        onClose={onCloseActionModal}
        title="Withdraw USDC"
        subtitle="Send funds to your authorized wallet."
      >
        <WithdrawView config={config} balance={balance} onAction={refreshBalance} />
      </ActionModal>
    </>
  );
}
