import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BalanceData, PaymentConfig } from './types';
import { useBalance, useConfig, queryKeys } from './hooks/queries';
import { Sidebar, type TabId } from './layout/Sidebar';
import { EmptyStateOverlay } from './layout/EmptyStateOverlay';
import { LoaderOverlay } from './layout/LoaderOverlay';
import { ActionModal } from './layout/ActionModal';
import { DepositView } from './components/DepositView';
import { WithdrawView } from './components/WithdrawView';
import { OverviewView } from './views/OverviewView';
import { EmissionsView } from './views/EmissionsView';
import { DiemRewardsView } from './views/DiemRewardsView';
import { EarnView } from './views/EarnView';
import { ChannelsView } from './components/ChannelsView';
import { AuthorizedWalletProvider } from './context/AuthorizedWalletContext';
import { AuthorizeWalletAlert } from './layout/AuthorizeWalletAlert';

export type OverlayPhase = 'deposit' | 'success' | null;

const VALID_TABS = new Set<TabId>(['overview', 'channels', 'earn', 'emissions', 'diem-rewards']);

function parseTabFromUrl(): TabId {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (!raw) return 'overview';
  // Legacy compat: the old deposits tab no longer exists, and the overview tab
  // was previously named "dashboard". Map both to the current overview tab.
  if (raw === 'deposit' || raw === 'deposits' || raw === 'dashboard') return 'overview';
  return VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'overview';
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
  const queryClient = useQueryClient();
  const { data: balance = null, isFetched: balanceFetched } = useBalance();
  const { data: config = null } = useConfig();
  const [activeTab, setActiveTab] = useState<TabId>(() => parseTabFromUrl());
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

  const refreshBalance = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.balance });
  }, [queryClient]);

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
        balanceLoaded={balanceFetched}
        config={config}
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        isDark={isDark}
        onToggleTheme={() => setIsDark((d) => !d)}
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
          config={config}
          balance={balance}
          buyerEvmAddress={buyerEvmAddress}
          onOpenDeposit={onOpenDeposit}
          onOpenWithdraw={onOpenWithdraw}
        />
        <div className="dash-main">
          <AuthorizeWalletAlert />
          <main className="dash-content">
            {activeTab === 'overview' && (
              <OverviewView
                config={config}
                balance={balance}
                onOpenDeposit={onOpenDeposit}
                onSelectTab={onSelectTab}
              />
            )}
            {activeTab === 'channels'  && <ChannelsView  config={config} />}
            {activeTab === 'earn' && <EarnView config={config} onSelectTab={onSelectTab} />}
            {activeTab === 'emissions' && <EmissionsView config={config} />}
            {activeTab === 'diem-rewards' && <DiemRewardsView config={config} />}
          </main>
        </div>
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
        variant="wide"
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
        variant="wide"
      >
        <WithdrawView config={config} balance={balance} onAction={refreshBalance} />
      </ActionModal>
    </>
  );
}
