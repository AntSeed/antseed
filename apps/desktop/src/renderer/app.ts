import { initChatModule } from './modules/chat';
import { initSettingsModule } from './modules/settings';
import { initRuntimeModule } from './modules/runtime';
import { initDashboardRenderModule } from './modules/dashboard-render';
import { initDashboardApiModule } from './modules/dashboard-api';
import {
  initPluginSetupModule,
  normalizeRouterRuntime,
  resolveRouterPackageName,
} from './modules/plugin-setup';
import { mountAppShell } from './ui/mount';
import { registerActions } from './ui/actions';
import {
  DEFAULT_DASHBOARD_PORT,
  POLL_INTERVAL_MS,
  UI_MESSAGES,
} from './core/constants';
import { safeNumber, safeString } from './core/safe';
import type { BadgeTone } from './core/state';
import { createInitialUiState } from './core/state';
import { initStore, notifyUiStateChanged } from './core/store';
import type { DesktopBridge } from './types/bridge';

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                          */
/* ------------------------------------------------------------------ */

function detectApplePlatform(): boolean {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platformHint = nav.userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platformHint);
}

const isMacPlatform = detectApplePlatform();
document.body.classList.toggle('platform-macos', isMacPlatform);

const bridge = window.antseedDesktop as DesktopBridge | undefined;
const uiState = createInitialUiState();
initStore(uiState);

bridge?.onFullscreenChange?.((isFullscreen) => {
  document.body.classList.toggle('platform-fullscreen', isFullscreen);
});
bridge?.onWindowFocusChange?.((isFocused) => {
  document.body.classList.toggle('window-blurred', !isFocused);
});

/* ------------------------------------------------------------------ */
/*  Module initialisation                                              */
/* ------------------------------------------------------------------ */

const {
  appendLog,
  renderLogs,
  isModeRunning,
  renderProcesses,
  renderDaemonState,
  appendSystemLog,
} = initRuntimeModule({ uiState });

const {
  getDashboardPort,
  getDashboardData,
  updateDashboardConfig,
  scanDhtNow,
  setRefreshHooks,
  refreshDashboardData,
} = initDashboardApiModule({
  bridge,
  uiState,
  defaultDashboardPort: DEFAULT_DASHBOARD_PORT,
});

const {
  clearRouterPluginHint,
  updatePluginHintFromLog,
  renderPluginSetupState,
  refreshPluginInventory,
  installPluginPackage,
} = initPluginSetupModule({
  bridge,
  uiState,
  appendSystemLog,
});

const { populateSettingsForm, saveConfig } = initSettingsModule({
  uiState,
  getDashboardData: getDashboardData as (
    endpoint: string,
    query?: Record<string, string | number | boolean>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null }>,
  updateDashboardConfig: updateDashboardConfig as (
    config: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null; status?: number | null }>,
});

const {
  renderDashboardData,
  renderOfflineState,
} = initDashboardRenderModule({
  uiState,
  isModeRunning,
  appendSystemLog,
  populateSettingsForm,
});

const chatApi = initChatModule({
  bridge,
  uiState,
  appendSystemLog,
});

/* ------------------------------------------------------------------ */
/*  Runtime activity helpers                                           */
/* ------------------------------------------------------------------ */

function isProxyPortOccupiedMessage(value: unknown): boolean {
  const message = safeString(value, '').toLowerCase();
  if (!message) return false;
  return message.includes('eaddrinuse') || message.includes('address already in use');
}

let runtimeActivityHoldUntil = 0;

function setRuntimeActivity(tone: BadgeTone, message: string, holdMs = 0): void {
  if (holdMs > 0) {
    runtimeActivityHoldUntil = Math.max(runtimeActivityHoldUntil, Date.now() + holdMs);
  }
  const text = safeString(message, '').trim() || 'Idle';
  if (uiState.runtimeActivity.message === text && uiState.runtimeActivity.tone === tone) {
    return;
  }
  uiState.runtimeActivity = { tone, message: text };
  notifyUiStateChanged();
}

function setRuntimeSteadyActivity(tone: BadgeTone, message: string): void {
  if (Date.now() < runtimeActivityHoldUntil) return;
  setRuntimeActivity(tone, message);
}

function syncRuntimeActivityFromProcesses(processes = uiState.processes): void {
  const buyerConnected = isModeRunning('connect', processes);
  setRuntimeSteadyActivity(
    buyerConnected ? 'active' : 'idle',
    buyerConnected
      ? 'Ready'
      : 'Buyer runtime offline. Waiting for local runtime start...',
  );
}

function syncBuyerRuntimeOverview(processes = uiState.processes): void {
  const buyerConnected = isModeRunning('connect', processes);
  uiState.ovNodeState = buyerConnected ? 'connected' : 'offline';

  if (!uiState.refreshing) {
    const badgeLabel = uiState.overviewBadge.label.toLowerCase();
    if (buyerConnected) {
      if (badgeLabel.includes('offline') || badgeLabel.includes('idle')) {
        uiState.overviewBadge = { tone: 'active', label: 'CONNECTED • Refreshing DHT status...' };
      }
    } else {
      uiState.overviewBadge = { tone: 'idle', label: 'OFFLINE' };
    }
  }

  notifyUiStateChanged();
}

function updateRuntimeActivityFromLog(mode: string, lineRaw: string): void {
  const line = safeString(lineRaw, '').toLowerCase();
  if (!line) return;

  if (mode === 'connect') {
    if (line.includes('connecting to p2p network')) {
      setRuntimeActivity('warn', 'Connecting to P2P network...', 6_000);
      return;
    }
    if (line.includes('connected to p2p network')) {
      setRuntimeActivity('active', 'Connected to P2P network.', 3_000);
      return;
    }
    if (line.includes('discovering peers')) {
      setRuntimeActivity('warn', 'Searching DHT for peers...', 6_000);
      return;
    }
    if (line.includes('/v1/models')) {
      setRuntimeActivity('warn', 'Loading model catalog from peers...', 8_000);
      return;
    }
    if (line.includes('proxy listening on')) {
      setRuntimeActivity('active', 'Buyer proxy online.', 4_000);
      return;
    }
    if (line.includes('no peers available')) {
      setRuntimeActivity('warn', 'No peers available for this request.', 8_000);
      return;
    }
    if (line.includes('timed out')) {
      setRuntimeActivity('bad', 'Peer request timed out. Retrying another route...', 10_000);
      return;
    }
  }

  if (mode === 'dashboard') {
    if (line.includes('running on http://127.0.0.1')) {
      setRuntimeActivity('active', 'Local data service ready.', 3_000);
      return;
    }
    if (line.includes('failed to start')) {
      setRuntimeActivity('warn', 'Local data service start fallback in progress...', 8_000);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Refresh                                                            */
/* ------------------------------------------------------------------ */

type RefreshReason = 'poll' | 'manual' | 'startup';

async function refreshAll(reason: RefreshReason = 'poll'): Promise<void> {
  if (!bridge?.getState || uiState.refreshing) return;

  uiState.refreshing = true;
  uiState.overviewBadge = { tone: 'warn', label: 'Refreshing runtime and peers...' };
  uiState.peersMessage = 'Refreshing peers and runtime status...';
  notifyUiStateChanged();

  if (reason !== 'poll') {
    setRuntimeActivity('warn', 'Refreshing runtime and peer snapshots...', 8_000);
  }

  try {
    const snapshot = await bridge.getState();
    renderLogs(snapshot.logs);
    renderProcesses(snapshot.processes);
    syncBuyerRuntimeOverview(snapshot.processes);
    renderDaemonState(snapshot.daemonState);
    await refreshDashboardData(snapshot.processes);
    syncRuntimeActivityFromProcesses(snapshot.processes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Refresh failed: ${message}`);
    uiState.peersMessage = `Unable to refresh runtime and peers: ${message}`;
    notifyUiStateChanged();
    setRuntimeActivity('bad', `Refresh failed: ${message}`, 10_000);
  } finally {
    uiState.refreshing = false;
    notifyUiStateChanged();
  }
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

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
  if (!bridge?.start || isModeRunning('connect')) return;

  try {
    setRuntimeActivity('warn', 'Starting buyer runtime...', 8_000);
    await bridge.start({
      mode: 'connect',
      router: normalizeRouterRuntime(uiState.connectRouterValue),
    });
    uiState.connectWarning = null;
    notifyUiStateChanged();
    appendSystemLog(UI_MESSAGES.buyerAutoStarted);
    setRuntimeActivity('active', 'Buyer runtime auto-started.', 4_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('already running')) return;
    if (isProxyPortOccupiedMessage(message)) {
      uiState.connectWarning = UI_MESSAGES.proxyPortInUse;
      notifyUiStateChanged();
    }
    appendSystemLog(`Buyer auto-start failed: ${message}`);
    setRuntimeActivity('bad', `Buyer auto-start failed: ${message}`, 10_000);
  }
}

async function actionStartConnect(): Promise<void> {
  const start = requireBridgeMethod('start', 'Runtime start is unavailable in this build');
  clearRouterPluginHint();
  uiState.connectState = 'Starting buyer runtime...';
  uiState.connectBadge = { tone: 'idle', label: 'Starting...' };
  notifyUiStateChanged();
  setRuntimeActivity('warn', 'Starting buyer runtime...', 8_000);
  try {
    await start({
      mode: 'connect',
      router: normalizeRouterRuntime(uiState.connectRouterValue),
    });
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isProxyPortOccupiedMessage(message)) {
      uiState.connectWarning = UI_MESSAGES.proxyPortInUse;
      notifyUiStateChanged();
    }
    appendSystemLog(`Action failed: ${message}`);
    setRuntimeActivity('bad', `Action failed: ${message}`, 8_000);
  }
}

async function actionStopConnect(): Promise<void> {
  const stop = requireBridgeMethod('stop', 'Runtime stop is unavailable in this build');
  uiState.connectState = 'Stopping buyer runtime...';
  uiState.connectBadge = { tone: 'idle', label: 'Stopping...' };
  notifyUiStateChanged();
  setRuntimeActivity('warn', 'Stopping buyer runtime...', 8_000);
  try {
    await stop('connect');
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Action failed: ${message}`);
    setRuntimeActivity('bad', `Action failed: ${message}`, 8_000);
  }
}

async function actionStartAll(): Promise<void> {
  if (isModeRunning('connect')) return;
  await actionStartConnect();
  uiState.connectWarning = null;
  notifyUiStateChanged();
}

async function actionStopAll(): Promise<void> {
  if (!isModeRunning('connect')) return;
  await actionStopConnect();
}

async function actionScanDht(): Promise<void> {
  uiState.peersMessage = 'Scanning DHT for peers...';
  uiState.peersMeta = { tone: 'warn', label: 'Scanning...' };
  uiState.overviewBadge = { tone: 'warn', label: 'Scanning DHT for peers...' };
  notifyUiStateChanged();
  setRuntimeActivity('warn', 'Scanning DHT for peers...', 12_000);
  try {
    const result = await scanDhtNow();
    if (!result.ok) {
      throw new Error(result.error ?? 'DHT scan failed');
    }
    appendSystemLog('Triggered immediate DHT scan.');
    setRuntimeActivity('active', 'DHT scan completed.', 4_000);
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`DHT scan failed: ${message}`);
    setRuntimeActivity('bad', `DHT scan failed: ${message}`, 8_000);
  }
}

async function actionClearLogs(): Promise<void> {
  const clearLogs = requireBridgeMethod('clearLogs', 'Log clearing is unavailable in this build');
  try {
    await clearLogs();
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Clear logs failed: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Register actions for React                                         */
/* ------------------------------------------------------------------ */

registerActions({
  startConnect: actionStartConnect,
  stopConnect: actionStopConnect,
  startAll: actionStartAll,
  stopAll: actionStopAll,
  refreshAll: () => refreshAll('manual'),
  clearLogs: actionClearLogs,
  scanDht: actionScanDht,
  saveConfig: saveConfig,
  createNewConversation: chatApi.createNewConversation,
  startNewChat: chatApi.startNewChat,
  openConversation: chatApi.openConversation,
  sendMessage: chatApi.sendMessage,
  abortChat: chatApi.abortChat,
  deleteConversation: chatApi.deleteConversation,
  renameConversation: chatApi.renameConversation,
  handleModelChange: chatApi.handleModelChange,
  handleModelFocus: chatApi.handleModelFocus,
  handleModelBlur: chatApi.handleModelBlur,
  refreshPlugins: refreshPluginInventory,
  installPlugin: () => {
    const packageName = resolveRouterPackageName(
      uiState.pluginHints.router || uiState.connectRouterValue,
    );
    return installPluginPackage(packageName);
  },
});

/* ------------------------------------------------------------------ */
/*  Mount React (store + actions both ready)                           */
/* ------------------------------------------------------------------ */

mountAppShell();

/* ------------------------------------------------------------------ */
/*  Refresh hooks (dashboard-api → dashboard-render bridge)            */
/* ------------------------------------------------------------------ */

setRefreshHooks({
  setDashboardRefreshState: (busy: boolean, stage: string) => {
    if (busy) {
      uiState.peersMessage = stage;
      uiState.peersMeta = { tone: 'warn', label: 'Refreshing...' };
      uiState.overviewBadge = { tone: 'active', label: stage };
      notifyUiStateChanged();
      return;
    }
    syncBuyerRuntimeOverview();
    syncRuntimeActivityFromProcesses();
  },
  renderDashboardData,
  refreshChatConversations: chatApi.refreshChatConversations,
  refreshChatProxyStatus: chatApi.refreshChatProxyStatus,
});

/* ------------------------------------------------------------------ */
/*  Bridge initialisation                                              */
/* ------------------------------------------------------------------ */

function initializeBridge(): void {
  if (!bridge) {
    appendSystemLog(UI_MESSAGES.desktopBridgeUnavailable);
    renderOfflineState('Desktop bridge unavailable.');
    setRuntimeActivity('bad', 'Desktop bridge unavailable.', 15_000);
    return;
  }

  let hasStructuredRuntimeActivity = false;

  bridge.onRuntimeActivity?.((activity) => {
    hasStructuredRuntimeActivity = true;
    const holdMs = Math.max(0, safeNumber(activity.holdMs, 0));
    setRuntimeActivity(activity.tone, activity.message, holdMs);
  });

  bridge.onLog?.((event) => {
    updatePluginHintFromLog(event);
    if (event.mode === 'connect' && isProxyPortOccupiedMessage(event.line)) {
      uiState.connectWarning = UI_MESSAGES.proxyPortInUse;
      notifyUiStateChanged();
    }

    appendLog(event);
    renderPluginSetupState();
    if (!hasStructuredRuntimeActivity) {
      updateRuntimeActivityFromLog(event.mode, event.line);
    }
  });

  bridge.onState?.((processes) => {
    const wasDashboardRunning = uiState.dashboardRunning;
    renderProcesses(processes);
    syncBuyerRuntimeOverview(processes);
    syncRuntimeActivityFromProcesses(processes);

    if (isModeRunning('connect', processes)) {
      uiState.connectWarning = null;
      notifyUiStateChanged();
      clearRouterPluginHint();
    }

    renderPluginSetupState();

    const nowDashboardRunning = isModeRunning('dashboard', processes);
    if (nowDashboardRunning !== wasDashboardRunning) {
      void refreshDashboardData(processes);
    }
  });

  if (bridge.start) {
    setRuntimeActivity('warn', 'Starting local data service...', 8_000);
    void bridge.start({
      mode: 'dashboard',
      dashboardPort: getDashboardPort(),
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (isProxyPortOccupiedMessage(message)) {
        appendSystemLog(UI_MESSAGES.localServicePortInUse);
        setRuntimeActivity('active', UI_MESSAGES.localServicePortInUse, 6_000);
        return;
      }
      appendSystemLog(`Background data service start failed: ${message}`);
      setRuntimeActivity('bad', `Data service start failed: ${message}`, 10_000);
    });
  }

  void (async () => {
    await refreshAll('startup');
    await ensureConnectRuntimeStarted();
    await refreshAll('startup');
  })();

  void refreshPluginInventory().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Plugin inventory refresh failed: ${message}`);
  });

  setInterval(() => {
    void refreshAll('poll');
  }, POLL_INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

renderPluginSetupState();
setRuntimeActivity('idle', 'Initializing desktop runtime...', 6_000);
initializeBridge();
