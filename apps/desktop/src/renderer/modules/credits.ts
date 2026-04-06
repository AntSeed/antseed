import type { RendererUiState } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import type { DesktopBridge } from '../types/bridge';

type CreditsModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  onBalanceSufficientForPayment?: () => void;
};

export type CreditsModuleApi = {
  refreshCredits: () => Promise<void>;
  startPeriodicRefresh: () => void;
  stopPeriodicRefresh: () => void;
  getAvailableUsdc: () => string;
};

const CREDITS_REFRESH_INTERVAL_MS = 60_000;
const CREDITS_FAST_REFRESH_INTERVAL_MS = 5_000;

const MAX_AUTO_RETRIES = 2;

export function initCreditsModule({ bridge, uiState, onBalanceSufficientForPayment }: CreditsModuleOptions): CreditsModuleApi {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let fastRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let autoRetryCount = 0;

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

        // Auto-retry: if the payment approval card is visible and balance
        // now covers the required amount, dismiss the card and retry.
        if (
          uiState.chatPaymentApprovalVisible &&
          !uiState.chatPaymentApprovalLoading &&
          onBalanceSufficientForPayment &&
          autoRetryCount < MAX_AUTO_RETRIES
        ) {
          const required = parseFloat(uiState.chatPaymentApprovalAmount || '0');
          if (available > 0 && required > 0 && available >= required) {
            stopFastRefresh();
            autoRetryCount++;
            onBalanceSufficientForPayment();
            // Fall through to notifyUiStateChanged so title bar balance updates
          }
        }

        // Reset retry counter when the payment card is dismissed
        if (!uiState.chatPaymentApprovalVisible) {
          autoRetryCount = 0;
        }

        // Start/stop fast polling based on whether the payment card is visible
        if (uiState.chatPaymentApprovalVisible && !fastRefreshTimer) {
          startFastRefresh();
        } else if (!uiState.chatPaymentApprovalVisible && fastRefreshTimer) {
          stopFastRefresh();
        }

        if (changed) notifyUiStateChanged();

      }
    } catch {
      // Silently fail — cached values remain
    }
  }

  function startFastRefresh(): void {
    if (fastRefreshTimer) return;
    fastRefreshTimer = setInterval(() => void refreshCredits(), CREDITS_FAST_REFRESH_INTERVAL_MS);
  }

  function stopFastRefresh(): void {
    if (fastRefreshTimer) {
      clearInterval(fastRefreshTimer);
      fastRefreshTimer = null;
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
    stopFastRefresh();
    window.removeEventListener('focus', onWindowFocus);
  }

  function getAvailableUsdc(): string {
    return uiState.creditsAvailableUsdc;
  }

  return { refreshCredits, startPeriodicRefresh, stopPeriodicRefresh, getAvailableUsdc };
}
