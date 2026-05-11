import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BalanceData, PaymentConfig } from '../../types';
import { queryKeys } from '../../hooks/queries';
import { useTabUrl } from '../../hooks/use-tab-url';
import { useTheme } from '../../hooks/use-theme';
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

export type OverlayPhase = 'deposit' | 'success' | null;

interface AppShellProps {
  balance: BalanceData | null;
  balanceLoaded: boolean;
  config: PaymentConfig | null;
}

export function AppShell({ balance, balanceLoaded, config }: AppShellProps) {
  const queryClient = useQueryClient();
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
  const buyerEvmAddress = config?.evmAddress ?? balance?.evmAddress ?? null;

  return (
    <>
      <div className={`dash-shell${shellBlurred ? ' dash-shell--blurred' : ''}`}>
        <Sidebar
          activeTab={activeTab}
          onSelect={selectTab}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          config={config}
          balance={balance}
          buyerEvmAddress={buyerEvmAddress}
          onOpenDeposit={openDeposit}
          onOpenWithdraw={openWithdraw}
        />
        <div className="dash-main">
          <AuthorizeWalletAlert />
          <main className="dash-content">
            {activeTab === 'overview' && (
              <OverviewView
                config={config}
                balance={balance}
                onOpenDeposit={openDeposit}
                onSelectTab={selectTab}
              />
            )}
            {activeTab === 'channels' && <ChannelsView config={config} />}
            {activeTab === 'earn' && <EarnView config={config} onSelectTab={selectTab} />}
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
        onClose={closeActionModal}
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
        onClose={closeActionModal}
        title="Withdraw USDC"
        subtitle="Send funds to your authorized wallet."
        variant="wide"
      >
        <WithdrawView config={config} balance={balance} onAction={refreshBalance} />
      </ActionModal>
    </>
  );
}
