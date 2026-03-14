import type { RendererUiState, ConfigFormData } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import { safeNumber, safeArray, safeString } from '../core/safe';

type SettingsModuleOptions = {
  uiState: RendererUiState;
  getDashboardData: (
    endpoint: string,
    query?: Record<string, string | number | boolean>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null }>;
  updateDashboardConfig: (
    config: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null; status?: number | null }>;
  setDebugLogs: (enabled: boolean) => Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const DESKTOP_DEV_MODE_KEY = 'antseed.desktop.devMode';

function loadDesktopDevMode(): boolean {
  try {
    return window.localStorage.getItem(DESKTOP_DEV_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistDesktopDevMode(value: boolean): void {
  try {
    window.localStorage.setItem(DESKTOP_DEV_MODE_KEY, value ? 'true' : 'false');
  } catch {
    // Ignore storage errors and continue with in-memory state.
  }
}

export function initSettingsModule({
  uiState,
  getDashboardData,
  updateDashboardConfig,
  setDebugLogs,
}: SettingsModuleOptions) {
  let configFormPopulated = false;
  uiState.devMode = loadDesktopDevMode();
  void setDebugLogs(uiState.devMode);

  function applyConfigFormData(formData: ConfigFormData): void {
    uiState.devMode = formData.devMode;
    uiState.configFormData = { ...formData };
  }

  function populateSettingsForm(config: unknown): void {
    if (!config || configFormPopulated) return;
    configFormPopulated = true;

    const configObj = asRecord(config);
    const buyer = asRecord(configObj.buyer);
    const buyerMaxPricing = asRecord(buyer.maxPricing);
    const buyerMaxPricingDefaults = asRecord(buyerMaxPricing.defaults);
    const payments = asRecord(configObj.payments);

    applyConfigFormData({
      proxyPort: safeNumber(buyer.proxyPort, 8377),
      maxInputUsdPerMillion: safeNumber(buyerMaxPricingDefaults.inputUsdPerMillion, 0),
      maxOutputUsdPerMillion: safeNumber(buyerMaxPricingDefaults.outputUsdPerMillion, 0),
      minRep: safeNumber(buyer.minPeerReputation, 0),
      paymentMethod: safeString(payments.preferredMethod, 'crypto'),
      devMode: uiState.devMode,
    });
    notifyUiStateChanged();
  }

  async function saveConfig(formData: ConfigFormData): Promise<void> {
    uiState.configSaving = true;
    persistDesktopDevMode(formData.devMode);
    void setDebugLogs(formData.devMode);
    applyConfigFormData(formData);
    notifyUiStateChanged();

    try {
      const result = await getDashboardData('config');
      if (!result.ok) {
        uiState.configMessage = { text: 'Failed to read current config', type: 'error' };
        notifyUiStateChanged();
        return;
      }

      const resultData = (result.data ?? {}) as Record<string, unknown>;
      const currentConfig = (resultData.config as Record<string, unknown> | undefined) ?? resultData;
      const merged = {
        ...currentConfig,
        buyer: {
          ...asRecord(currentConfig.buyer),
          proxyPort: formData.proxyPort,
          maxPricing: {
            defaults: {
              inputUsdPerMillion: formData.maxInputUsdPerMillion,
              outputUsdPerMillion: formData.maxOutputUsdPerMillion,
            },
          },
          minPeerReputation: formData.minRep,
        },
        payments: {
          ...asRecord(currentConfig.payments),
          preferredMethod: formData.paymentMethod || 'crypto',
        },
      };

      const response = await updateDashboardConfig(merged);
      if (response.ok) {
        applyConfigFormData(formData);
        uiState.configMessage = { text: 'Configuration saved successfully', type: 'success' };
        configFormPopulated = false;
      } else {
        uiState.configMessage = {
          text: response.error ?? `Failed to save configuration${response.status ? ` (${String(response.status)})` : ''}`,
          type: 'error',
        };
      }
    } catch (err) {
      uiState.configMessage = {
        text: `Error saving: ${err instanceof Error ? err.message : String(err)}`,
        type: 'error',
      };
    } finally {
      uiState.configSaving = false;
      notifyUiStateChanged();
    }
  }

  return {
    populateSettingsForm,
    saveConfig,
  };
}
