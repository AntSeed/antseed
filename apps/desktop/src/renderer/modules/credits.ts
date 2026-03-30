import type { RendererUiState } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import type { DesktopBridge } from '../types/bridge';
import { getActions } from '../ui/actions';

type CreditsModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
};

export type CreditsModuleApi = {
  refreshCredits: () => Promise<void>;
  startPeriodicRefresh: () => void;
  stopPeriodicRefresh: () => void;
  getAvailableUsdc: () => string;
};

const CREDITS_REFRESH_INTERVAL_MS = 60_000;

export function initCreditsModule({ bridge, uiState }: CreditsModuleOptions): CreditsModuleApi {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  async function refreshCredits(): Promise<void> {
    if (!bridge?.creditsGetInfo) return;

    try {
      const result = await bridge.creditsGetInfo();
      if (result.ok && result.data) {
        // Only notify if values actually changed
        const changed =
          uiState.creditsAvailableUsdc !== result.data.availableUsdc ||
          uiState.creditsReservedUsdc !== result.data.reservedUsdc ||
          uiState.creditsTotalUsdc !== result.data.balanceUsdc ||
          uiState.creditsEvmAddress !== result.data.evmAddress ||
          uiState.creditsOperatorAddress !== (result.data.operatorAddress ?? null);

        uiState.creditsAvailableUsdc = result.data.availableUsdc;
        uiState.creditsReservedUsdc = result.data.reservedUsdc;
        uiState.creditsTotalUsdc = result.data.balanceUsdc;
        uiState.creditsPendingWithdrawalUsdc = result.data.pendingWithdrawalUsdc;
        uiState.creditsCreditLimitUsdc = result.data.creditLimitUsdc;
        uiState.creditsEvmAddress = result.data.evmAddress;
        uiState.creditsOperatorAddress = result.data.operatorAddress ?? null;
        uiState.creditsLastRefreshedAt = Date.now();

        // Clear channel badges when no funds are reserved (all channels closed)
        const reserved = parseFloat(uiState.creditsReservedUsdc);
        if (reserved === 0 && uiState.chatActiveChannels.size > 0) {
          uiState.chatActiveChannels.clear();
        }

        // Low balance detection
        const available = parseFloat(uiState.creditsAvailableUsdc);
        const lowBalance = available > 0 && (available < 1.0 || (reserved > 0 && available < reserved));
        if (uiState.chatLowBalanceWarning !== lowBalance) {
          uiState.chatLowBalanceWarning = lowBalance;
        }

        if (changed) notifyUiStateChanged();

        const required = parseFloat(uiState.chatPaymentApprovalAmount || '0');
        const manualApproval = Boolean(uiState.configFormData?.requireManualApproval);
        if (
          changed
          && uiState.chatPaymentApprovalVisible
          && !uiState.chatPaymentApprovalLoading
          && !uiState.chatSending
          && !manualApproval
          && Number.isFinite(required)
          && required > 0
          && available >= required
        ) {
          getActions().approvePaymentSession();
        }
      }
    } catch {
      // Silently fail — cached values remain
    }
  }

  function onWindowFocus(): void {
    void refreshCredits();
  }

  function startPeriodicRefresh(): void {
    if (refreshTimer) return;
    void refreshCredits();
    refreshTimer = setInterval(() => void refreshCredits(), CREDITS_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', onWindowFocus);
  }

  function stopPeriodicRefresh(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    window.removeEventListener('focus', onWindowFocus);
  }

  function getAvailableUsdc(): string {
    return uiState.creditsAvailableUsdc;
  }

  return { refreshCredits, startPeriodicRefresh, stopPeriodicRefresh, getAvailableUsdc };
}
