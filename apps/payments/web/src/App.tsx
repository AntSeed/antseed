import { useState, useEffect, useCallback, useRef } from 'react';
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
import { SettingsView } from './views/SettingsView';
import { AuthorizedWalletProvider } from './context/AuthorizedWalletContext';
import { useAuthorizedWallet } from './context/AuthorizedWalletContext';
import { AuthorizeWalletAlert } from './layout/AuthorizeWalletAlert';
import { PayPage, type PayPageAction, type PayPagePopup } from './views/PayPage';

export type OverlayPhase = 'deposit' | 'success' | null;

const VALID_TABS = new Set<TabId>(['overview', 'rewards', 'diem-rewards', 'activity', 'settings']);

function parseTabFromUrl(): TabId {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (!raw) return 'overview';
  // Legacy compat: the old deposits tab no longer exists; fall through to dashboard.
  if (raw === 'deposit' || raw === 'deposits' || raw === 'dashboard') return 'overview';
  if (raw === 'channels') return 'activity';
  if (raw === 'emissions') return 'rewards';
  return VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'overview';
}

/**
 * Slim pay-only mode (`?page=pay&action=...`): the desktop app opens the
 * browser only for actions that need an external wallet signature. No
 * sidebar or tabs — just the single payment card.
 */
function parsePayPageFromUrl(): { action: PayPageAction; amount: string | null; popup: PayPagePopup } | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('page') !== 'pay') return null;
  const action = params.get('action');
  // Set by the desktop app: 'app' = the user's real browser in chromeless
  // app mode (extension wallets available); 'win' = Electron popup fallback
  // (WalletConnect/QR only). Both self-close after payment.
  const popupRaw = params.get('popup');
  const popup: PayPagePopup = popupRaw === 'app' ? 'app' : popupRaw ? 'win' : null;
  return {
    action: action === 'withdraw' || action === 'authorize' ? action : 'deposit',
    amount: params.get('amount'),
    popup,
  };
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
  const [balanceError, setBalanceError] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(() => parseTabFromUrl());
  const [walletDrawerOpen, setWalletDrawerOpen] = useState(false);
  const [actionModal, setActionModal] = useState<'deposit' | 'withdraw' | null>(() => shouldOpenDepositFromUrl() ? 'deposit' : null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [payPage] = useState(() => parsePayPageFromUrl());
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
    // The standalone checkout is always light (white payment page), whatever
    // the portal theme is. Don't persist that override.
    document.documentElement.setAttribute('data-theme', payPage ? 'light' : isDark ? 'dark' : 'light');
    if (!payPage) localStorage.setItem('antseed-payments-theme', isDark ? 'dark' : 'light');
  }, [isDark, payPage]);

  const fetchBalance = useCallback(async () => {
    try {
      const data = await getBalance();
      setBalance(data);
      setBalanceError(false);
      setBalanceLoaded(true);
    } catch {
      // Don't spin forever on a failed fetch — surface it and keep retrying so a
      // transient network blip self-heals without the user reloading the page.
      setBalanceError(true);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => { void fetchBalance(); }, 5000);
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    await fetchBalance();
    setTimeout(fetchBalance, 3000);
  }, [fetchBalance]);

  useEffect(() => {
    void fetchBalance();
    void getConfig().then(setConfig).catch(() => {});
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
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

  if (payPage) {
    return (
      <AuthorizedWalletProvider config={config}>
        <PayPage
          action={payPage.action}
          amount={payPage.amount}
          popup={payPage.popup}
          config={config}
          balance={balance}
          buyerEvmAddress={buyerEvmAddress}
          refreshBalance={refreshBalance}
        />
        {sessionExpired && (
          <div className="session-expired-overlay" role="alert">
            <div className="session-expired-card">
              <h2 className="session-expired-title">Session expired</h2>
              <p className="session-expired-subtitle">
                Please reopen this page from the desktop app or CLI to get a new session.
              </p>
            </div>
          </div>
        )}
      </AuthorizedWalletProvider>
    );
  }

  return (
    <AuthorizedWalletProvider config={config}>
      <AppShell
        balance={balance}
        balanceLoaded={balanceLoaded}
        balanceError={balanceError}
        onRetryBalance={fetchBalance}
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
  balanceError: boolean;
  onRetryBalance: () => void;
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
  balanceError,
  onRetryBalance,
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
  const authorizedWallet = useAuthorizedWallet();

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
        />
        <div className="dash-main">
          <TopBar
            activeTab={activeTab}
            balance={balance}
            buyerEvmAddress={buyerEvmAddress}
            atRisk={authorizedWallet.operatorSet === false && Number(balance?.total ?? 0) > 0}
            isDark={isDark}
            onToggleTheme={onToggleTheme}
            onOpenWallet={onOpenWalletDrawer}
          />
          <AuthorizeWalletAlert />
          <main className="dash-content">
            {activeTab === 'overview' && (
              <DashboardView
                config={config}
                balance={balance}
                onOpenDeposit={onOpenDeposit}
                onOpenWithdraw={onOpenWithdraw}
                onOpenActivity={() => onSelectTab('activity')}
              />
            )}
            {activeTab === 'rewards' && <EmissionsView config={config} />}
            {activeTab === 'diem-rewards' && <DiemRewardsView config={config} />}
            {activeTab === 'activity' && <ChannelsView config={config} />}
            {activeTab === 'settings' && (
              <SettingsView
                config={config}
              />
            )}
          </main>
        </div>
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
      <LoaderOverlay isVisible={isLoading} error={balanceError} onRetry={onRetryBalance} />
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
