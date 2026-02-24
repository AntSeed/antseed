type SettingsElements = Record<string, HTMLElement | null | undefined> & {
  configMessage?: HTMLElement | null;
  configSaveBtn?: HTMLButtonElement | null;
  cfgReserveFloor?: HTMLInputElement | null;
  cfgSellerInputUsdPerMillion?: HTMLInputElement | null;
  cfgSellerOutputUsdPerMillion?: HTMLInputElement | null;
  cfgMaxBuyers?: HTMLInputElement | null;
  cfgProxyPort?: HTMLInputElement | null;
  cfgPreferredProviders?: HTMLInputElement | null;
  cfgBuyerMaxInputUsdPerMillion?: HTMLInputElement | null;
  cfgBuyerMaxOutputUsdPerMillion?: HTMLInputElement | null;
  cfgMinRep?: HTMLInputElement | null;
  cfgPaymentMethod?: HTMLInputElement | HTMLSelectElement | null;
};

type SettingsModuleOptions = {
  elements: SettingsElements;
  safeObject: (value: unknown) => Record<string, unknown> | null;
  safeArray: (value: unknown) => unknown[];
  safeNumber: (value: unknown, fallback?: number) => number;
  safeString: (value: unknown, fallback?: string) => string;
  getDashboardData: (endpoint: any, query?: any) => Promise<{ ok: boolean; data: unknown; error?: string | null }>;
  getDashboardPort: () => number;
};

function setInputValue(el: HTMLInputElement | HTMLSelectElement | null | undefined, value: string | number): void {
  if (el) {
    el.value = String(value);
  }
}

function getInputValue(el: HTMLInputElement | HTMLSelectElement | null | undefined, fallback = ''): string {
  return el?.value ?? fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function initSettingsModule({
  elements,
  safeObject,
  safeArray,
  safeNumber,
  safeString,
  getDashboardData,
  getDashboardPort,
}: SettingsModuleOptions) {
  let configFormPopulated = false;

  function populateSettingsForm(config: unknown): void {
    if (!config || configFormPopulated) return;
    configFormPopulated = true;

    const configObj = asRecord(config);
    const seller = asRecord(configObj.seller);
    const buyer = asRecord(configObj.buyer);
    const sellerPricing = asRecord(seller.pricing);
    const sellerPricingDefaults = asRecord(sellerPricing.defaults);
    const buyerMaxPricing = asRecord(buyer.maxPricing);
    const buyerMaxPricingDefaults = asRecord(buyerMaxPricing.defaults);
    const payments = asRecord(configObj.payments);

    setInputValue(elements.cfgReserveFloor, safeNumber(seller.reserveFloor, 0));
    setInputValue(elements.cfgSellerInputUsdPerMillion, safeNumber(sellerPricingDefaults.inputUsdPerMillion, 0));
    setInputValue(elements.cfgSellerOutputUsdPerMillion, safeNumber(sellerPricingDefaults.outputUsdPerMillion, 0));
    setInputValue(elements.cfgMaxBuyers, safeNumber(seller.maxConcurrentBuyers, 1));
    setInputValue(elements.cfgProxyPort, safeNumber(buyer.proxyPort, 8377));
    setInputValue(elements.cfgPreferredProviders, safeArray(buyer.preferredProviders).join(', '));
    setInputValue(elements.cfgBuyerMaxInputUsdPerMillion, safeNumber(buyerMaxPricingDefaults.inputUsdPerMillion, 0));
    setInputValue(elements.cfgBuyerMaxOutputUsdPerMillion, safeNumber(buyerMaxPricingDefaults.outputUsdPerMillion, 0));
    setInputValue(elements.cfgMinRep, safeNumber(buyer.minPeerReputation, 0));
    setInputValue(elements.cfgPaymentMethod, safeString(payments.preferredMethod, 'crypto'));
  }

  function getSettingsFromForm() {
    return {
      seller: {
        reserveFloor: parseInt(getInputValue(elements.cfgReserveFloor, '0'), 10) || 0,
        pricing: {
          defaults: {
            inputUsdPerMillion: parseFloat(getInputValue(elements.cfgSellerInputUsdPerMillion, '0')) || 0,
            outputUsdPerMillion: parseFloat(getInputValue(elements.cfgSellerOutputUsdPerMillion, '0')) || 0,
          },
        },
        maxConcurrentBuyers: parseInt(getInputValue(elements.cfgMaxBuyers, '1'), 10) || 1,
      },
      buyer: {
        proxyPort: parseInt(getInputValue(elements.cfgProxyPort, '8377'), 10) || 8377,
        preferredProviders: getInputValue(elements.cfgPreferredProviders, '')
          .split(',')
          .map((provider) => provider.trim())
          .filter((provider) => provider.length > 0),
        maxPricing: {
          defaults: {
            inputUsdPerMillion: parseFloat(getInputValue(elements.cfgBuyerMaxInputUsdPerMillion, '0')) || 0,
            outputUsdPerMillion: parseFloat(getInputValue(elements.cfgBuyerMaxOutputUsdPerMillion, '0')) || 0,
          },
        },
        minPeerReputation: parseInt(getInputValue(elements.cfgMinRep, '0'), 10) || 0,
      },
    };
  }

  function showConfigMessage(text: string, type: 'error' | 'success'): void {
    const messageEl = elements.configMessage;
    if (!messageEl) return;
    messageEl.textContent = text;
    messageEl.className = `message settings-message ${type}`;
    setTimeout(() => {
      if (messageEl.textContent === text) {
        messageEl.textContent = '';
        messageEl.className = 'message';
      }
    }, 5000);
  }

  async function saveConfig(): Promise<void> {
    const configData = getSettingsFromForm();
    const saveBtn = elements.configSaveBtn;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    try {
      const result = await getDashboardData('config');
      if (!result.ok) {
        showConfigMessage('Failed to read current config', 'error');
        return;
      }

      const resultData = (result.data ?? {}) as Record<string, unknown>;
      const currentConfig = (resultData.config as Record<string, unknown> | undefined) ?? resultData;
      const merged = { ...currentConfig, ...configData };

      const port = getDashboardPort();
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });

      if (response.ok) {
        showConfigMessage('Configuration saved successfully', 'success');
        configFormPopulated = false;
      } else {
        showConfigMessage('Failed to save configuration', 'error');
      }
    } catch (err) {
      showConfigMessage(`Error saving: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }
  }

  if (elements.configSaveBtn) {
    elements.configSaveBtn.addEventListener('click', () => {
      void saveConfig();
    });
  }

  return {
    populateSettingsForm,
  };
}
