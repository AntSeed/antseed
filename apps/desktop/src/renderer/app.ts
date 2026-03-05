import { initChatModule } from './modules/chat';
import { initSettingsModule } from './modules/settings';
import { initRuntimeModule } from './modules/runtime';
import { initDashboardRenderModule } from './modules/dashboard-render';
import { initDashboardApiModule } from './modules/dashboard-api';
import { initPluginSetupModule } from './modules/plugin-setup';
import { mountAppShell } from './ui/mount';
import {
  DEFAULT_DASHBOARD_PORT,
  POLL_INTERVAL_MS,
  UI_MESSAGES,
} from './core/constants';
import { createRendererElements, setBadgeTone, setText } from './core/elements';
import type { BadgeTone } from './core/elements';
import {
  formatClock,
  formatDuration,
  formatEndpoint,
  formatInt,
  formatLatency,
  formatPercent,
  formatRelativeTime,
  formatShortId,
} from './core/format';
import { safeArray, safeNumber, safeObject, safeString } from './core/safe';
import { createInitialUiState } from './core/state';
import type { DesktopBridge } from './types/bridge';

const isMacPlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
document.body.classList.toggle('platform-macos', isMacPlatform);
mountAppShell();

const bridge = window.antseedDesktop as DesktopBridge | undefined;
const elements = createRendererElements();
const uiState = createInitialUiState();

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
  normalizeRouterRuntime,
  resolveRouterPackageName,
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

let runtimeActivityHoldUntil = 0;
let runtimeActivityLast = '';
let runtimeActivityTone: BadgeTone = 'idle';

function applyRuntimeActivity(tone: BadgeTone, message: string): void {
  if (!elements.runtimeActivity) {
    return;
  }

  const text = safeString(message, '').trim() || 'Idle';
  if (runtimeActivityLast === text && runtimeActivityTone === tone) {
    return;
  }

  runtimeActivityLast = text;
  runtimeActivityTone = tone;
  elements.runtimeActivity.classList.remove(
    'runtime-activity-idle',
    'runtime-activity-active',
    'runtime-activity-warn',
    'runtime-activity-bad',
  );
  elements.runtimeActivity.classList.add(`runtime-activity-${tone}`);
  elements.runtimeActivity.textContent = text;
}

function setRuntimeActivity(tone: BadgeTone, message: string, holdMs = 0): void {
  if (holdMs > 0) {
    runtimeActivityHoldUntil = Math.max(runtimeActivityHoldUntil, Date.now() + holdMs);
  }
  applyRuntimeActivity(tone, message);
}

function setRuntimeSteadyActivity(tone: BadgeTone, message: string): void {
  if (Date.now() < runtimeActivityHoldUntil) {
    return;
  }
  applyRuntimeActivity(tone, message);
}

function syncRuntimeActivityFromProcesses(processes = uiState.processes): void {
  const buyerConnected = isModeRunning('connect', processes);
  setRuntimeSteadyActivity(
    buyerConnected ? 'active' : 'idle',
    buyerConnected
      ? 'Buyer runtime connected. Waiting for peers and requests...'
      : 'Buyer runtime offline. Waiting for local runtime start...',
  );
}

function syncBuyerRuntimeOverview(processes = uiState.processes): void {
  const buyerConnected = isModeRunning('connect', processes);
  setText(elements.ovNodeState, buyerConnected ? 'connected' : 'offline');

  if (uiState.refreshing) {
    return;
  }

  const badgeText = safeString(elements.overviewBadge?.textContent, '').toLowerCase();
  if (buyerConnected) {
    if (badgeText.includes('offline') || badgeText.includes('idle')) {
      setBadgeTone(elements.overviewBadge, 'active', 'CONNECTED • Refreshing DHT status...');
    }
    return;
  }

  setBadgeTone(elements.overviewBadge, 'idle', 'OFFLINE');
}

function updateRuntimeActivityFromLog(mode: string, lineRaw: string): void {
  const line = safeString(lineRaw, '').toLowerCase();
  if (!line) {
    return;
  }

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

type RefreshReason = 'poll' | 'manual' | 'startup';

async function refreshAll(reason: RefreshReason = 'poll'): Promise<void> {
  if (!bridge?.getState || uiState.refreshing) {
    return;
  }

  uiState.refreshing = true;
  setBadgeTone(elements.overviewBadge, 'warn', 'Refreshing runtime and peers...');
  setText(elements.peersMessage, 'Refreshing peers and runtime status...');
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
    setText(elements.peersMessage, `Unable to refresh runtime and peers: ${message}`);
    setRuntimeActivity('bad', `Refresh failed: ${message}`, 10_000);
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
          await refreshAll('manual');
        }
      } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((buttonId === 'connectStartBtn' || buttonId === 'startAllBtn') && isProxyPortOccupiedMessage(message)) {
        setConnectWarning(UI_MESSAGES.proxyPortInUse);
      }
      appendSystemLog(`Action failed: ${message}`);
      setRuntimeActivity('bad', `Action failed: ${message}`, 8_000);
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
    setRuntimeActivity('warn', 'Starting buyer runtime...', 8_000);
    await bridge.start({
      mode: 'connect',
      router: normalizeRouterRuntime(elements.connectRouter?.value),
    });
    setConnectWarning(null);
    appendSystemLog(UI_MESSAGES.buyerAutoStarted);
    setRuntimeActivity('active', 'Buyer runtime auto-started.', 4_000);
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
    setRuntimeActivity('bad', `Buyer auto-start failed: ${message}`, 10_000);
  }
}

function bindControls(): void {
  bindAction('connectStartBtn', async () => {
    const start = requireBridgeMethod('start', 'Runtime start is unavailable in this build');
    clearRouterPluginHint();
    setText(elements.connectState, 'Starting buyer runtime...');
    if (elements.connectBadge) {
      elements.connectBadge.textContent = 'Starting...';
      elements.connectBadge.classList.remove('running', 'stopped', 'error');
      elements.connectBadge.classList.add('stopped');
    }
    setRuntimeActivity('warn', 'Starting buyer runtime...', 8_000);
    await start({
      mode: 'connect',
      router: normalizeRouterRuntime(elements.connectRouter?.value),
    });
  });

  bindAction('connectStopBtn', async () => {
    const stop = requireBridgeMethod('stop', 'Runtime stop is unavailable in this build');
    setText(elements.connectState, 'Stopping buyer runtime...');
    if (elements.connectBadge) {
      elements.connectBadge.textContent = 'Stopping...';
      elements.connectBadge.classList.remove('running', 'stopped', 'error');
      elements.connectBadge.classList.add('stopped');
    }
    setRuntimeActivity('warn', 'Stopping buyer runtime...', 8_000);
    await stop('connect');
  });

  bindAction('refreshBtn', async () => {
    await refreshAll('manual');
  });

  bindAction('clearLogsBtn', async () => {
    const clearLogs = requireBridgeMethod('clearLogs', 'Log clearing is unavailable in this build');
    await clearLogs();
  });

  bindAction('startAllBtn', async () => {
    if (isModeRunning('connect')) {
      return;
    }

    const start = requireBridgeMethod('start', 'Runtime start is unavailable in this build');
    setText(elements.connectState, 'Starting buyer runtime...');
    if (elements.connectBadge) {
      elements.connectBadge.textContent = 'Starting...';
      elements.connectBadge.classList.remove('running', 'stopped', 'error');
      elements.connectBadge.classList.add('stopped');
    }
    setRuntimeActivity('warn', 'Starting buyer runtime...', 8_000);
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
    setText(elements.connectState, 'Stopping buyer runtime...');
    if (elements.connectBadge) {
      elements.connectBadge.textContent = 'Stopping...';
      elements.connectBadge.classList.remove('running', 'stopped', 'error');
      elements.connectBadge.classList.add('stopped');
    }
    setRuntimeActivity('warn', 'Stopping buyer runtime...', 8_000);
    await stop('connect');
  });

  const scanAction = async () => {
    setText(elements.peersMessage, 'Scanning DHT for peers...');
    setBadgeTone(elements.peersMeta, 'warn', 'Scanning...');
    setBadgeTone(elements.overviewBadge, 'warn', 'Scanning DHT for peers...');
    setRuntimeActivity('warn', 'Scanning DHT for peers...', 12_000);
    const result = await scanDhtNow();
    if (!result.ok) {
      throw new Error(result.error ?? 'DHT scan failed');
    }
    appendSystemLog('Triggered immediate DHT scan.');
    setRuntimeActivity('active', 'DHT scan completed.', 4_000);
  };

  bindAction('scanNetworkBtn', scanAction);
  bindAction('scanNetworkBtnPeers', scanAction);

  bindAction('refreshPluginsBtn', async () => {
    await refreshPluginInventory();
  }, { refreshAfter: false });

  bindAction('installConnectPluginBtn', async () => {
    const packageName = resolveRouterPackageName(uiState.pluginHints.router || elements.connectRouter?.value);
    await installPluginPackage(packageName);
  }, { refreshAfter: false });

  elements.connectRouter?.addEventListener('input', () => {
    clearRouterPluginHint();
    renderPluginSetupState();
  });
}

function initializeBridge(renderOfflineState: (message: string) => void): void {
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
      setConnectWarning(UI_MESSAGES.proxyPortInUse);
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
      setConnectWarning(null);
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

const { populateSettingsForm } = initSettingsModule({
  elements,
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
  formatRelativeTime,
  formatDuration,
  formatInt,
  formatPercent,
  formatLatency,
  formatShortId,
  formatEndpoint,
  setText,
  setBadgeTone,
  isModeRunning,
  appendSystemLog,
  populateSettingsForm,
});

const { refreshChatConversations, refreshChatProxyStatus } = initChatModule({
  bridge,
  elements,
  uiState,
  setBadgeTone,
  appendSystemLog,
  setRuntimeActivity,
});

  setRefreshHooks({
    setDashboardRefreshState: (busy: boolean, stage: string) => {
      if (busy) {
        setText(elements.peersMessage, stage);
        setBadgeTone(elements.peersMeta, 'warn', 'Refreshing...');
        setBadgeTone(elements.overviewBadge, 'warn', stage);
        return;
      }
      syncBuyerRuntimeOverview();
      syncRuntimeActivityFromProcesses();
    },
  renderOfflineState,
  renderDashboardData,
  refreshChatConversations,
  refreshChatProxyStatus,
});

renderPluginSetupState();
bindControls();
initSortableHeaders();
bindPeerFilter();
setRuntimeActivity('idle', 'Initializing desktop runtime...', 6_000);
initializeBridge(renderOfflineState);
