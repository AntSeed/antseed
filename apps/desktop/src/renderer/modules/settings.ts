import type { RendererUiState, ConfigFormData } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import { safeNumber, safeArray, safeString } from '../core/safe';

type SettingsModuleOptions = {
  uiState: RendererUiState;
  getDashboardData: (
    endpoint: string,
    query?: Record<string, string | number | boolean>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null }>;
  getDashboardPort: () => number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function initSettingsModule({
  uiState,
  getDashboardData,
  getDashboardPort,
}: SettingsModuleOptions) {
  let configFormPopulated = false;

  function populateSettingsForm(config: unknown): void {
    if (!config || configFormPopulated) return;
    configFormPopulated = true;

    const configObj = asRecord(config);
    const buyer = asRecord(configObj.buyer);
    const buyerMaxPricing = asRecord(buyer.maxPricing);
    const buyerMaxPricingDefaults = asRecord(buyerMaxPricing.defaults);
    const payments = asRecord(configObj.payments);

    uiState.configFormData = {
      proxyPort: safeNumber(buyer.proxyPort, 8377),
      preferredProviders: safeArray(buyer.preferredProviders).join(', '),
      maxInputUsdPerMillion: safeNumber(buyerMaxPricingDefaults.inputUsdPerMillion, 0),
      maxOutputUsdPerMillion: safeNumber(buyerMaxPricingDefaults.outputUsdPerMillion, 0),
      minRep: safeNumber(buyer.minPeerReputation, 0),
      paymentMethod: safeString(payments.preferredMethod, 'crypto'),
    };
    notifyUiStateChanged();
  }

  async function saveConfig(formData: ConfigFormData): Promise<void> {
    uiState.configSaving = true;
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
          preferredProviders: formData.preferredProviders
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p.length > 0),
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

      const port = getDashboardPort();
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });

      if (response.ok) {
        uiState.configMessage = { text: 'Configuration saved successfully', type: 'success' };
        configFormPopulated = false;
      } else {
        uiState.configMessage = { text: 'Failed to save configuration', type: 'error' };
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
