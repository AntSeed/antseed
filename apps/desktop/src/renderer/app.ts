import { initChatModule } from './modules/chat';
import { initSettingsModule } from './modules/settings';
import { initRuntimeModule } from './modules/runtime';
import { initDashboardRenderModule } from './modules/dashboard-render';
import { initNavigationModule } from './modules/navigation';
import { initDashboardApiModule } from './modules/dashboard-api';
import { initSeedAuthModule } from './modules/seed-auth';
import { initPluginSetupModule } from './modules/plugin-setup';
import {
  DEFAULT_DASHBOARD_PORT,
  POLL_INTERVAL_MS,
  STORAGE_KEYS,
  UI_MESSAGES,
} from './core/constants';
import { createRendererElements, setBadgeTone, setText } from './core/elements';
import {
  getCapacityColor,
  formatClock,
  formatDuration,
  formatEndpoint,
  formatInt,
  formatLatency,
  formatMoney,
  formatPercent,
  formatPrice,
  formatRelativeTime,
  formatShortId,
  formatTimestamp,
} from './core/format';
import { safeArray, safeNumber, safeObject, safeString } from './core/safe';
import { createInitialUiState } from './core/state';
import type { DesktopBridge } from './types/bridge';

const isMacPlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
document.body.classList.toggle('platform-macos', isMacPlatform);

const bridge = window.antseedDesktop as DesktopBridge | undefined;
const elements = createRendererElements();
const uiState = createInitialUiState();

const navButtons = Array.from(document.querySelectorAll<HTMLElement>('.sidebar-btn[data-view]'));
const views = Array.from(document.querySelectorAll<HTMLElement>('.view'));
const toolbarViews = new Set<string>();

const {
  setActiveView,
  getActiveView,
  setAppMode,
  initNavigation,
} = initNavigationModule({
  uiState,
  navButtons,
  views,
  toolbarViews,
  storageKey: STORAGE_KEYS.appMode,
});

const {
  appendLog,
  renderLogs,
  isModeRunning,
  renderProcesses,
  renderDaemonState,
  appendSystemLog,
} = initRuntimeModule({
  elements,
  uiState,
  formatClock,
  formatDuration,
  setText,
});

const {
  getDashboardPort,
  getDashboardData,
  scanDhtNow,
  setRefreshHooks,
  refreshDashboardData,
} = initDashboardApiModule({
  bridge,
  elements,
  uiState,
  defaultDashboardPort: DEFAULT_DASHBOARD_PORT,
  safeNumber,
  safeArray,
});

const {
  initSeedAuthControls,
  persistSeedAuthPrefs,
  buildSeedRuntimeEnv,
} = initSeedAuthModule({
  elements,
  storageKey: STORAGE_KEYS.seedAuthPrefs,
});

const {
  normalizeProviderRuntime,
  normalizeRouterRuntime,
  resolveProviderPackageName,
  resolveRouterPackageName,
  clearProviderPluginHint,
  clearRouterPluginHint,
  updatePluginHintFromLog,
  renderPluginSetupState,
  refreshPluginInventory,
  installPluginPackage,
} = initPluginSetupModule({
  bridge,
  elements,
  uiState,
  appendSystemLog,
});

function isProxyPortOccupiedMessage(value: unknown): boolean {
  const message = safeString(value, '').toLowerCase();
  if (!message) {
    return false;
  }
  return message.includes('eaddrinuse') || message.includes('address already in use');
}

function setConnectWarning(message: string | null): void {
  if (!elements.connectWarning) {
    return;
  }

  const text = safeString(message, '').trim();
  if (!text) {
    elements.connectWarning.textContent = '';
    elements.connectWarning.hidden = true;
    return;
  }

  elements.connectWarning.textContent = text;
  elements.connectWarning.hidden = false;
}

async function refreshAll(): Promise<void> {
  if (!bridge?.getState || uiState.refreshing) {
    return;
  }

  uiState.refreshing = true;
  try {
    const snapshot = await bridge.getState();
    renderLogs(snapshot.logs);
    renderProcesses(snapshot.processes);
    renderDaemonState(snapshot.daemonState);
    await refreshDashboardData(snapshot.processes);
  } finally {
    uiState.refreshing = false;
  }
}

type ActionOptions = {
  refreshAfter: boolean;
};

const DEFAULT_ACTION_OPTIONS: ActionOptions = {
  refreshAfter: true,
};

function getActionButton(buttonId: string): HTMLButtonElement | null {
  return document.getElementById(buttonId) as HTMLButtonElement | null;
}

function bindAction(
  buttonId: string,
  action: () => Promise<void>,
  options: ActionOptions = DEFAULT_ACTION_OPTIONS,
): void {
  const button = getActionButton(buttonId);
  if (!button) {
    return;
  }

  if (!bridge) {
    button.disabled = true;
    return;
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await action();
      if (options.refreshAfter) {
        await refreshAll();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((buttonId === 'connectStartBtn' || buttonId === 'startAllBtn') && isProxyPortOccupiedMessage(message)) {
        setConnectWarning(UI_MESSAGES.proxyPortInUse);
      }
      appendSystemLog(`Action failed: ${message}`);
    } finally {
      button.disabled = false;
    }
  });
}

function requireBridgeMethod<K extends keyof DesktopBridge>(
  key: K,
  unavailableMessage: string,
): NonNullable<DesktopBridge[K]> {
  const method = bridge?.[key];
  if (typeof method !== 'function') {
    throw new Error(unavailableMessage);
  }
  return method as NonNullable<DesktopBridge[K]>;
}

async function ensureConnectRuntimeStarted(): Promise<void> {
  if (!bridge?.start) {
    return;
  }

  if (isModeRunning('connect')) {
    return;
  }

  try {
    await bridge.start({
      mode: 'connect',
      router: normalizeRouterRuntime(elements.connectRouter?.value),
    });
    setConnectWarning(null);
    appendSystemLog(UI_MESSAGES.buyerAutoStarted);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    if (normalized.includes('already running')) {
      return;
    }

    if (isProxyPortOccupiedMessage(message)) {
      setConnectWarning(UI_MESSAGES.proxyPortInUse);
    }

    appendSystemLog(`Buyer auto-start failed: ${message}`);
  }
}

function bindControls(): void {
  bindAction('seedStartBtn', async () => {
    const start = requireBridgeMethod('start', 'Runtime start is unavailable in this build');
    clearProviderPluginHint();
    persistSeedAuthPrefs();
    await start({
      mode: 'seed',
      provider: normalizeProviderRuntime(elements.seedProvider?.value),
      env: buildSeedRuntimeEnv(),
    });
  });

  bindAction('seedStopBtn', async () => {
    const stop = requireBridgeMethod('stop', 'Runtime stop is unavailable in this build');
    await stop('seed');
  });

  bindAction('connectStartBtn', async () => {
    const start = requireBridgeMethod('start', 'Runtime start is unavailable in this build');
    clearRouterPluginHint();
    await start({
      mode: 'connect',
      router: normalizeRouterRuntime(elements.connectRouter?.value),
    });
  });

  bindAction('connectStopBtn', async () => {
    const stop = requireBridgeMethod('stop', 'Runtime stop is unavailable in this build');
    await stop('connect');
  });

  bindAction('refreshBtn', refreshAll);

  bindAction('clearLogsBtn', async () => {
    const clearLogs = requireBridgeMethod('clearLogs', 'Log clearing is unavailable in this build');
    await clearLogs();
  });

  bindAction('startAllBtn', async () => {
    if (isModeRunning('connect')) {
      return;
    }

    const start = requireBridgeMethod('start', 'Runtime start is unavailable in this build');
    await start({
      mode: 'connect',
      router: normalizeRouterRuntime(elements.connectRouter?.value),
    });
    setConnectWarning(null);
  });

  bindAction('stopAllBtn', async () => {
    if (!isModeRunning('connect')) {
      return;
    }

    const stop = requireBridgeMethod('stop', 'Runtime stop is unavailable in this build');
    await stop('connect');
  });

  const scanAction = async () => {
    const result = await scanDhtNow();
    if (!result.ok) {
      throw new Error(result.error ?? 'DHT scan failed');
    }
    appendSystemLog('Triggered immediate DHT scan.');
  };

  bindAction('scanNetworkBtn', scanAction);
  bindAction('scanNetworkBtnPeers', scanAction);

  bindAction('refreshPluginsBtn', async () => {
    await refreshPluginInventory();
  }, { refreshAfter: false });

  bindAction('installSeedPluginBtn', async () => {
    const packageName = resolveProviderPackageName(uiState.pluginHints.provider || elements.seedProvider?.value);
    await installPluginPackage(packageName);
  }, { refreshAfter: false });

  bindAction('installConnectPluginBtn', async () => {
    const packageName = resolveRouterPackageName(uiState.pluginHints.router || elements.connectRouter?.value);
    await installPluginPackage(packageName);
  }, { refreshAfter: false });

  elements.seedProvider?.addEventListener('input', () => {
    clearProviderPluginHint();
    renderPluginSetupState();
  });

  elements.connectRouter?.addEventListener('input', () => {
    clearRouterPluginHint();
    renderPluginSetupState();
  });
}

function initializeBridge(renderOfflineState: (message: string) => void): void {
  if (!bridge) {
    appendSystemLog(UI_MESSAGES.desktopBridgeUnavailable);
    renderOfflineState('Desktop bridge unavailable.');
    return;
  }

  bridge.onLog?.((event) => {
    updatePluginHintFromLog(event);
    if (event.mode === 'connect' && isProxyPortOccupiedMessage(event.line)) {
      setConnectWarning(UI_MESSAGES.proxyPortInUse);
    }

    appendLog(event);
    renderPluginSetupState();
  });

  bridge.onState?.((processes) => {
    const wasDashboardRunning = uiState.dashboardRunning;
    renderProcesses(processes);

    if (isModeRunning('connect', processes)) {
      setConnectWarning(null);
      clearRouterPluginHint();
    }

    if (isModeRunning('seed', processes)) {
      clearProviderPluginHint();
    }

    renderPluginSetupState();

    const nowDashboardRunning = isModeRunning('dashboard', processes);
    if (nowDashboardRunning !== wasDashboardRunning) {
      void refreshDashboardData(processes);
    }
  });

  if (bridge.start) {
    void bridge.start({
      mode: 'dashboard',
      dashboardPort: getDashboardPort(),
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (isProxyPortOccupiedMessage(message)) {
        appendSystemLog(UI_MESSAGES.localServicePortInUse);
        return;
      }
      appendSystemLog(`Background data service start failed: ${message}`);
    });
  }

  void (async () => {
    await refreshAll();
    await ensureConnectRuntimeStarted();
    await refreshAll();
  })();

  void refreshPluginInventory().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Plugin inventory refresh failed: ${message}`);
  });

  setInterval(() => {
    void refreshAll();
  }, POLL_INTERVAL_MS);
}

if (elements.ovSessionsCard) {
  elements.ovSessionsCard.title = 'Open Sessions view';
  elements.ovSessionsCard.addEventListener('click', () => {
    setActiveView('sessions');
  });
}

const { populateSettingsForm } = initSettingsModule({
  elements,
  safeObject,
  safeArray,
  safeNumber,
  safeString,
  getDashboardData,
  getDashboardPort,
});

const {
  renderDashboardData,
  renderOfflineState,
  initSortableHeaders,
  bindPeerFilter,
} = initDashboardRenderModule({
  elements,
  uiState,
  safeNumber,
  safeArray,
  safeString,
  safeObject,
  formatTimestamp,
  formatRelativeTime,
  formatDuration,
  formatInt,
  formatPercent,
  formatMoney,
  formatPrice,
  formatLatency,
  formatShortId,
  formatEndpoint,
  getCapacityColor,
  setText,
  setBadgeTone,
  isModeRunning,
  getActiveView,
  setActiveView,
  appendSystemLog,
  populateSettingsForm,
});

const refreshWalletInfo = async () => {};

const { refreshChatConversations, refreshChatProxyStatus } = initChatModule({
  bridge,
  elements,
  uiState,
  setBadgeTone,
  appendSystemLog,
});

setRefreshHooks({
  isModeRunning,
  renderOfflineState,
  renderDashboardData,
  refreshWalletInfo,
  refreshChatConversations,
  refreshChatProxyStatus,
  appendSystemLog,
});

function initPeriodToggle(): void {
  const buttons = document.querySelectorAll<HTMLElement>('.toggle-btn[data-period]');
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      uiState.earningsPeriod = btn.dataset.period || uiState.earningsPeriod;
      for (const toggleButton of buttons) {
        toggleButton.classList.toggle('active', toggleButton.dataset.period === uiState.earningsPeriod);
      }
      void refreshAll();
    });
  }
}

initNavigation();
setActiveView('chat');
setAppMode('connect');

renderPluginSetupState();
initSeedAuthControls();
bindControls();
initSortableHeaders();
bindPeerFilter();
initPeriodToggle();
initializeBridge(renderOfflineState);
