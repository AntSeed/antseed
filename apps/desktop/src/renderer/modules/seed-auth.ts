import type { RendererElements } from '../core/elements';
import { STORAGE_KEYS } from '../core/constants';
import { safeString } from '../core/safe';

export type SeedAuthType = 'apikey' | 'oauth' | 'claude-code';

type SeedAuthPrefs = {
  authType?: string;
  authValue?: string;
};

type SeedAuthModuleOptions = {
  elements: RendererElements;
  storageKey?: string;
};

function isSeedAuthType(value: string): value is SeedAuthType {
  return value === 'apikey' || value === 'oauth' || value === 'claude-code';
}

function loadSeedAuthPrefs(storageKey: string): SeedAuthPrefs {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as SeedAuthPrefs;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

export function getSelectedSeedAuthType(elements: RendererElements): SeedAuthType {
  const raw = safeString(elements.seedAuthType?.value, 'apikey').toLowerCase();
  if (isSeedAuthType(raw)) {
    return raw;
  }
  return 'apikey';
}

function saveSeedAuthPrefs(elements: RendererElements, storageKey: string): void {
  const authType = getSelectedSeedAuthType(elements);
  const authValue = safeString(elements.seedAuthValue?.value, '');

  localStorage.setItem(
    storageKey,
    JSON.stringify({
      authType,
      authValue,
    }),
  );
}

function renderSeedAuthInputs(elements: RendererElements): void {
  const authType = getSelectedSeedAuthType(elements);
  const label = elements.seedAuthValueLabel;
  const input = elements.seedAuthValue;

  if (!label || !input) {
    return;
  }

  if (authType === 'claude-code') {
    label.textContent = 'Auth Value (not required)';
    label.appendChild(input);
    input.placeholder = 'Claude Code keychain will be used';
    input.disabled = true;
    return;
  }

  input.disabled = false;
  if (authType === 'oauth') {
    label.textContent = 'OAuth Access Token';
    label.appendChild(input);
    input.placeholder = 'Paste OAuth access token';
    return;
  }

  label.textContent = 'API Key';
  label.appendChild(input);
  input.placeholder = 'Paste API key';
}

function applySeedAuthPrefs(elements: RendererElements, prefs: SeedAuthPrefs): void {
  const prefType = safeString(prefs.authType, '');
  const prefValue = safeString(prefs.authValue, '');

  if (elements.seedAuthType) {
    elements.seedAuthType.value = isSeedAuthType(prefType) ? prefType : 'apikey';
  }

  if (elements.seedAuthValue) {
    elements.seedAuthValue.value = prefValue;
  }
}

export function initSeedAuthModule({
  elements,
  storageKey = STORAGE_KEYS.seedAuthPrefs,
}: SeedAuthModuleOptions) {
  function initSeedAuthControls(): void {
    applySeedAuthPrefs(elements, loadSeedAuthPrefs(storageKey));

    if (elements.seedAuthType) {
      elements.seedAuthType.addEventListener('change', () => {
        renderSeedAuthInputs(elements);
        saveSeedAuthPrefs(elements, storageKey);
      });
    }

    if (elements.seedAuthValue) {
      elements.seedAuthValue.addEventListener('input', () => {
        saveSeedAuthPrefs(elements, storageKey);
      });
    }

    renderSeedAuthInputs(elements);
  }

  function persistSeedAuthPrefs(): void {
    saveSeedAuthPrefs(elements, storageKey);
  }

  function buildSeedRuntimeEnv(): Record<string, string> {
    const authType = getSelectedSeedAuthType(elements);
    const authValue = safeString(elements.seedAuthValue?.value, '').trim();

    const env: Record<string, string> = {
      ANTSEED_AUTH_TYPE: authType,
    };

    if (authType !== 'claude-code') {
      if (!authValue) {
        if (authType === 'oauth') {
          throw new Error('OAuth access token is required for auth type "oauth".');
        }
        throw new Error('API key is required for auth type "apikey".');
      }
      env.ANTHROPIC_API_KEY = authValue;
    }

    return env;
  }

  return {
    initSeedAuthControls,
    persistSeedAuthPrefs,
    buildSeedRuntimeEnv,
  };
}
