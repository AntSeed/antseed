import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useBalance } from '../../hooks/queries';
import { useTabUrl } from '../../hooks/use-tab-url';
import { useTheme } from '../../hooks/use-theme';
import { AppShellContext, type AppShellContextValue, type OverlayPhase } from '../../context/app-shell-context';
import { Sidebar } from './sidebar';
import { AuthorizeWalletAlert } from './authorize-wallet-alert';
import { LoaderOverlay } from '../modals/loader-overlay';
import { EmptyStateOverlay } from '../modals/empty-state-overlay';
import { ActionModal } from '../modals/action-modal';
import { DepositView } from '../../views/deposit-view';
import { WithdrawView } from '../../views/withdraw-view';
import { OverviewView } from '../../views/overview-view';
import { EmissionsView } from '../../views/emissions-view';
import { DiemRewardsView } from '../../views/diem-rewards-view';
import { EarnView } from '../../views/earn-view';
import { ChannelsView } from '../../views/channels-view';

export function AppShell() {
  const queryClient = useQueryClient();
  const { data: balance = null, isFetched: balanceFetched } = useBalance();
  const { activeTab, selectTab, initialActionModal, clearDepositAction } = useTabUrl();
  const { isDark, toggleTheme } = useTheme();
  const [actionModal, setActionModal] = useState<'deposit' | 'withdraw' | null>(initialActionModal);
  const [justDeposited, setJustDeposited] = useState(false);
  const [depositPromptDismissed, setDepositPromptDismissed] = useState(false);

  const refreshBalance = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.balance });
  }, [queryClient]);

  const openDeposit = useCallback(() => setActionModal('deposit'), []);
  const openWithdraw = useCallback(() => setActionModal('withdraw'), []);
  const closeActionModal = useCallback(() => {
    setActionModal(null);
    clearDepositAction();
  }, [clearDepositAction]);

  const handleDeposited = useCallback(async () => {
    setJustDeposited(true);
    closeActionModal();
    await refreshBalance();
  }, [refreshBalance, closeActionModal]);

  const dismissSuccess = useCallback(() => setJustDeposited(false), []);
  const dismissDepositPrompt = useCallback(() => setDepositPromptDismissed(true), []);

  const isLoading = !balanceFetched;
  const isEmptyBuyer =
    balanceFetched &&
    balance !== null &&
    parseFloat(balance.total) === 0 &&
    parseFloat(balance.reserved) === 0;

  let overlayPhase: OverlayPhase = null;
  if (justDeposited) overlayPhase = 'success';
  else if (isEmptyBuyer && !depositPromptDismissed) overlayPhase = 'deposit';

  const shellBlurred = isLoading || overlayPhase !== null;

  const value: AppShellContextValue = useMemo(
    () => ({
      activeTab,
      selectTab,
      isDark,
      toggleTheme,
      openDeposit,
      openWithdraw,
      refreshBalance,
      handleDeposited,
    }),
    [activeTab, selectTab, isDark, toggleTheme, openDeposit, openWithdraw, refreshBalance, handleDeposited],
  );

  return (
    <AppShellContext.Provider value={value}>
      <div className={`dash-shell${shellBlurred ? ' dash-shell--blurred' : ''}`}>
        <Sidebar />
        <div className="dash-main">
          <AuthorizeWalletAlert />
          <main className="dash-content">
            {activeTab === 'overview' && <OverviewView />}
            {activeTab === 'channels' && <ChannelsView />}
            {activeTab === 'earn' && <EarnView />}
            {activeTab === 'emissions' && <EmissionsView />}
            {activeTab === 'diem-rewards' && <DiemRewardsView />}
          </main>
        </div>
      </div>
      <LoaderOverlay isVisible={isLoading} />
      <EmptyStateOverlay
        phase={overlayPhase}
        onContinue={dismissSuccess}
        onDismissDeposit={dismissDepositPrompt}
      />
      <ActionModal
        isOpen={actionModal === 'deposit'}
        onClose={closeActionModal}
        title="Deposit USDC"
        subtitle="Add credits to your AntSeed account with a guided two-step flow."
        variant="wide"
      >
        <DepositView />
      </ActionModal>
      <ActionModal
        isOpen={actionModal === 'withdraw'}
        onClose={closeActionModal}
        title="Withdraw USDC"
        subtitle="Send funds to your authorized wallet."
        variant="wide"
      >
        <WithdrawView />
      </ActionModal>
    </AppShellContext.Provider>
  );
}
