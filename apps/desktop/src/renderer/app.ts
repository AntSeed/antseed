import { initWalletModule } from './modules/wallet';
import { initChatModule } from './modules/chat';
import { initSettingsModule } from './modules/settings';
import { initRuntimeModule } from './modules/runtime';
import { initDashboardRenderModule } from './modules/dashboard-render';
import { initNavigationModule } from './modules/navigation';
import { initDashboardApiModule } from './modules/dashboard-api';

type AnyRecord = Record<string, any>;

const bridge: any = window.antseedDesktop;
const DEFAULT_DASHBOARD_PORT = 3117;
const POLL_INTERVAL_MS = 5000;
const SEED_AUTH_PREFS_KEY = 'antseed-seed-auth-prefs';
const DEFAULT_PROVIDER_RUNTIME = 'anthropic';
const DEFAULT_ROUTER_RUNTIME = 'local-proxy';

const PROVIDER_PACKAGE_ALIASES: Record<string, string> = {
  anthropic: '@antseed/provider-anthropic',
  openrouter: '@antseed/provider-openrouter',
  'local-llm': '@antseed/provider-local-llm',
  'provider-anthropic': '@antseed/provider-anthropic',
  'provider-openrouter': '@antseed/provider-openrouter',
  'provider-local-llm': '@antseed/provider-local-llm',
  'antseed-provider-anthropic': '@antseed/provider-anthropic',
  'antseed-provider-openrouter': '@antseed/provider-openrouter',
  'antseed-provider-local-llm': '@antseed/provider-local-llm',
  '@antseed/provider-anthropic': '@antseed/provider-anthropic',
  '@antseed/provider-openrouter': '@antseed/provider-openrouter',
  '@antseed/provider-local-llm': '@antseed/provider-local-llm',
};

const ROUTER_PACKAGE_ALIASES: Record<string, string> = {
  'local-proxy': '@antseed/router-local-proxy',
  'claude-code': '@antseed/router-local-proxy',
  'local-chat': '@antseed/router-local-chat',
  'router-local-proxy': '@antseed/router-local-proxy',
  'router-local-chat': '@antseed/router-local-chat',
  'antseed-router-claude-code': '@antseed/router-local-proxy',
  'antseed-router-local-proxy': '@antseed/router-local-proxy',
  'antseed-router-local-chat': '@antseed/router-local-chat',
  '@antseed/router-local-proxy': '@antseed/router-local-proxy',
  '@antseed/router-local-chat': '@antseed/router-local-chat',
};

const uiState: AnyRecord = {
  processes: [],
  refreshing: false,
  dashboardRunning: false,
  lastActiveSessions: 0,
  daemonState: null,
  lastSessionDebugKey: '',
  peerSort: { key: 'reputation', dir: 'desc' },
  sessionSort: { key: 'startedAt', dir: 'desc' },
  peerFilter: '',
  lastPeers: [],
  lastSessionsPayload: null,
  earningsPeriod: 'month',
  walletInfo: null,
  walletMode: 'node',
  wcState: { connected: false, address: null, chainId: null, pairingUri: null },
  chatActiveConversation: null,
  chatConversations: [],
  chatMessages: [],
  chatSending: false,
  appMode: 'seeder',
  installedPlugins: new Set<string>(),
  pluginHints: {
    provider: null,
    router: null,
  },
  pluginInstallBusy: false,
};

function byId(id: string): any {
  return document.getElementById(id);
}

function setText(el: any, value: string): void {
  if (el) {
    el.textContent = value;
  }
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function safeObject(value) {
  if (value && typeof value === 'object') {
    return value;
  }
  return null;
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

function formatTimestamp(timestamp) {
  const ts = safeNumber(timestamp, 0);
  if (ts <= 0) {
    return 'n/a';
  }
  return new Date(ts).toLocaleString();
}

function formatRelativeTime(timestamp) {
  const ts = safeNumber(timestamp, 0);
  if (ts <= 0) {
    return 'n/a';
  }

  const diffMs = Date.now() - ts;
  if (diffMs < 0) {
    return 'now';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(durationMs) {
  const ms = safeNumber(durationMs, 0);
  if (ms <= 0) {
    return '0s';
  }

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

function formatInt(value) {
  return Math.round(safeNumber(value, 0)).toLocaleString();
}

function formatPercent(value) {
  const pct = safeNumber(value, 0);
  return `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

function getCapacityColor(percent) {
  if (percent > 80) {
    return 'var(--accent)';
  }
  if (percent > 50) {
    return 'var(--accent-yellow)';
  }
  return 'var(--accent-green)';
}

function getWalletActionResult(result, successMessage, errorMessage) {
  if (result.ok) {
    return {
      message: result.message || successMessage,
      type: 'success',
    };
  }

  return {
    message: result.error || errorMessage,
    type: 'error',
  };
}

function formatMoney(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return '$0.00';
    }
    const numeric = Number(normalized);
    if (!Number.isNaN(numeric)) {
      return `$${numeric.toFixed(2)}`;
    }
    return `$${normalized}`;
  }

  const numeric = safeNumber(value, 0);
  return `$${numeric.toFixed(2)}`;
}

function formatPrice(value) {
  const numeric = safeNumber(value, 0);
  if (numeric <= 0) {
    return 'n/a';
  }
  if (numeric < 0.01) {
    return `$${numeric.toFixed(4)}`;
  }
  return `$${numeric.toFixed(2)}`;
}

function formatLatency(value) {
  const numeric = safeNumber(value, 0);
  if (numeric <= 0) {
    return 'n/a';
  }
  return `${Math.round(numeric)}ms`;
}

function formatShortId(id, head = 8, tail = 6) {
  if (typeof id !== 'string' || id.length === 0) {
    return 'unknown';
  }
  if (id.length <= head + tail + 3) {
    return id;
  }
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

function formatEndpoint(peer) {
  const host = safeString(peer.host, '').trim();
  const port = safeNumber(peer.port, 0);
  if (host.length > 0 && port > 0) {
    return `${host}:${port}`;
  }
  return '-';
}

function loadSeedAuthPrefs() {
  try {
    const raw = localStorage.getItem(SEED_AUTH_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSeedAuthPrefs() {
  const authType = safeString(elements.seedAuthType?.value, 'apikey');
  const authValue = safeString(elements.seedAuthValue?.value, '');
  const next = {
    authType,
    authValue,
  };
  localStorage.setItem(SEED_AUTH_PREFS_KEY, JSON.stringify(next));
}

function getSelectedSeedAuthType() {
  const raw = safeString(elements.seedAuthType?.value, 'apikey').toLowerCase();
  if (raw === 'oauth' || raw === 'claude-code' || raw === 'apikey') {
    return raw;
  }
  return 'apikey';
}

function renderSeedAuthInputs() {
  const authType = getSelectedSeedAuthType();
  const label = elements.seedAuthValueLabel;
  const input = elements.seedAuthValue;
  if (!label || !input) return;

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
  } else {
    label.textContent = 'API Key';
    label.appendChild(input);
    input.placeholder = 'Paste API key';
  }
}

function buildSeedRuntimeEnv() {
  const authType = getSelectedSeedAuthType();
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
    env['ANTHROPIC_API_KEY'] = authValue;
  }

  return env;
}

function initSeedAuthControls() {
  const prefs = loadSeedAuthPrefs();
  const prefType = safeString(prefs.authType, '');
  const prefValue = safeString(prefs.authValue, '');

  if (elements.seedAuthType) {
    if (prefType === 'apikey' || prefType === 'oauth' || prefType === 'claude-code') {
      elements.seedAuthType.value = prefType;
    } else {
      elements.seedAuthType.value = 'apikey';
    }
    elements.seedAuthType.addEventListener('change', () => {
      renderSeedAuthInputs();
      saveSeedAuthPrefs();
    });
  }

  if (elements.seedAuthValue) {
    elements.seedAuthValue.value = prefValue;
    elements.seedAuthValue.addEventListener('input', () => {
      saveSeedAuthPrefs();
    });
  }

  renderSeedAuthInputs();
}

function normalizePluginSlug(value, fallback) {
  const raw = safeString(value, fallback).trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || fallback;
}

function normalizeProviderRuntime(value) {
  const raw = safeString(value, DEFAULT_PROVIDER_RUNTIME).trim().toLowerCase();
  if (!raw) return DEFAULT_PROVIDER_RUNTIME;
  if (raw === '@antseed/provider-anthropic' || raw === 'antseed-provider-anthropic') return 'anthropic';
  if (raw === '@antseed/provider-openrouter' || raw === 'antseed-provider-openrouter') return 'openrouter';
  if (raw === '@antseed/provider-local-llm' || raw === 'antseed-provider-local-llm') return 'local-llm';
  return raw;
}

function normalizeRouterRuntime(value) {
  const raw = safeString(value, DEFAULT_ROUTER_RUNTIME).trim().toLowerCase();
  if (!raw) return DEFAULT_ROUTER_RUNTIME;
  if (
    raw === 'claude-code'
    || raw === '@antseed/router-local-proxy'
    || raw === 'antseed-router-claude-code'
    || raw === 'antseed-router-local-proxy'
  ) {
    return 'local-proxy';
  }
  if (raw === '@antseed/router-local-chat' || raw === 'antseed-router-local-chat') {
    return 'local-chat';
  }
  return raw;
}

function resolveProviderPackageName(value) {
  const raw = safeString(value, DEFAULT_PROVIDER_RUNTIME).trim().toLowerCase();
  if (!raw) return PROVIDER_PACKAGE_ALIASES[DEFAULT_PROVIDER_RUNTIME];
  if (PROVIDER_PACKAGE_ALIASES[raw]) return PROVIDER_PACKAGE_ALIASES[raw];
  if (raw.startsWith('@')) return raw;
  if (raw.startsWith('provider-')) return `@antseed/${raw}`;
  return `@antseed/provider-${normalizePluginSlug(raw, DEFAULT_PROVIDER_RUNTIME)}`;
}

function resolveRouterPackageName(value) {
  const raw = safeString(value, DEFAULT_ROUTER_RUNTIME).trim().toLowerCase();
  if (!raw) return ROUTER_PACKAGE_ALIASES[DEFAULT_ROUTER_RUNTIME];
  if (ROUTER_PACKAGE_ALIASES[raw]) return ROUTER_PACKAGE_ALIASES[raw];
  if (raw.startsWith('@')) return raw;
  if (raw.startsWith('router-')) return `@antseed/${raw}`;
  return `@antseed/router-${normalizePluginSlug(raw, DEFAULT_ROUTER_RUNTIME)}`;
}

function expectedProviderPluginPackage() {
  return resolveProviderPackageName(elements.seedProvider?.value);
}

function expectedRouterPluginPackage() {
  return resolveRouterPackageName(elements.connectRouter?.value);
}

function extractMissingPluginPackage(logLine) {
  const match = /Plugin\s+"([^"]+)"\s+not found/i.exec(safeString(logLine, ''));
  return match?.[1]?.trim() || null;
}

function updatePluginHintFromLog(event) {
  const pkg = extractMissingPluginPackage(event?.line);
  if (!pkg) return;

  if (event.mode === 'seed') {
    uiState.pluginHints.provider = resolveProviderPackageName(pkg);
  } else if (event.mode === 'connect') {
    uiState.pluginHints.router = resolveRouterPackageName(pkg);
  } else if (pkg.includes('-provider-') || pkg.includes('/provider-')) {
    uiState.pluginHints.provider = resolveProviderPackageName(pkg);
  } else if (pkg.includes('-router-') || pkg.includes('/router-')) {
    uiState.pluginHints.router = resolveRouterPackageName(pkg);
  }
}

function renderPluginSetupState() {
  const expectedProvider = uiState.pluginHints.provider || expectedProviderPluginPackage();
  const expectedRouter = uiState.pluginHints.router || expectedRouterPluginPackage();

  const installedProvider = uiState.installedPlugins.has(expectedProvider);
  const installedRouter = uiState.installedPlugins.has(expectedRouter);
  const missing: string[] = [];
  if (!installedProvider) missing.push(expectedProvider);
  if (!installedRouter) missing.push(expectedRouter);

  if (elements.pluginSetupStatus) {
    if (missing.length === 0) {
      elements.pluginSetupStatus.textContent = 'Required runtime plugins are installed.';
    } else {
      elements.pluginSetupStatus.textContent = `Missing plugin${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
    }
  }

  if (elements.installSeedPluginBtn) {
    elements.installSeedPluginBtn.textContent = installedProvider
      ? `Seller Ready (${expectedProvider})`
      : `Install ${expectedProvider}`;
    elements.installSeedPluginBtn.disabled = uiState.pluginInstallBusy || installedProvider || !bridge?.pluginsInstall;
  }

  if (elements.installConnectPluginBtn) {
    elements.installConnectPluginBtn.textContent = installedRouter
      ? `Buyer Ready (${expectedRouter})`
      : `Install ${expectedRouter}`;
    elements.installConnectPluginBtn.disabled = uiState.pluginInstallBusy || installedRouter || !bridge?.pluginsInstall;
  }

  if (elements.refreshPluginsBtn) {
    elements.refreshPluginsBtn.disabled = uiState.pluginInstallBusy || !bridge?.pluginsList;
  }
}

async function refreshPluginInventory() {
  if (!bridge?.pluginsList) {
    return;
  }
  const result = await bridge.pluginsList();
  if (!result?.ok) {
    throw new Error(result?.error || 'Failed to read installed plugins');
  }
  uiState.installedPlugins = new Set(safeArray(result.plugins).map((plugin) => safeString(plugin?.package, '')).filter(Boolean));
  renderPluginSetupState();
}

async function installPluginPackage(packageName) {
  if (!bridge?.pluginsInstall) {
    throw new Error('Plugin installer is unavailable in this build');
  }
  uiState.pluginInstallBusy = true;
  renderPluginSetupState();
  try {
    const result = await bridge.pluginsInstall(packageName);
    if (!result?.ok) {
      throw new Error(result?.error || `Failed to install ${packageName}`);
    }
    uiState.installedPlugins = new Set(safeArray(result.plugins).map((plugin) => safeString(plugin?.package, '')).filter(Boolean));
    appendSystemLog(`Installed ${packageName}.`);
    uiState.pluginHints.provider = null;
    uiState.pluginHints.router = null;
    renderPluginSetupState();
  } finally {
    uiState.pluginInstallBusy = false;
    renderPluginSetupState();
  }
}

const elements = {
  seedState: byId('seedState'),
  connectState: byId('connectState'),
  seedBadge: byId('seedBadge'),
  connectBadge: byId('connectBadge'),
  runtimeSummary: byId('runtimeSummary'),
  daemonState: byId('daemonState'),
  logs: byId('logs'),

  seedProvider: byId('seedProvider'),
  seedAuthType: byId('seedAuthType'),
  seedAuthValue: byId('seedAuthValue'),
  seedAuthValueLabel: byId('seedAuthValueLabel'),
  connectRouter: byId('connectRouter'),
  pluginSetupCard: byId('pluginSetupCard'),
  pluginSetupStatus: byId('pluginSetupStatus'),
  refreshPluginsBtn: byId('refreshPluginsBtn'),
  installSeedPluginBtn: byId('installSeedPluginBtn'),
  installConnectPluginBtn: byId('installConnectPluginBtn'),

  overviewBadge: byId('overviewBadge'),
  ovNodeState: byId('ovNodeState'),
  ovPeers: byId('ovPeers'),
  ovSessionsCard: byId('ovSessionsCard'),
  ovSessions: byId('ovSessions'),
  ovEarnings: byId('ovEarnings'),
  ovDhtHealth: byId('ovDhtHealth'),
  ovUptime: byId('ovUptime'),
  ovPeersCount: byId('ovPeersCount'),
  overviewPeersBody: byId('overviewPeersBody'),
  capacityArc: byId('capacityArc'),
  capacityPercent: byId('capacityPercent'),
  ovProxyPort: byId('ovProxyPort'),
  ovCapSessions: byId('ovCapSessions'),
  ovCapPeers: byId('ovCapPeers'),
  ovCapDht: byId('ovCapDht'),
  miniChartContainer: byId('miniChartContainer'),

  peersMeta: byId('peersMeta'),
  peersMessage: byId('peersMessage'),
  peersBody: byId('peersBody'),
  peersHead: byId('peersHead'),
  peerFilter: byId('peerFilter'),

  sessionsMeta: byId('sessionsMeta'),
  sessionsMessage: byId('sessionsMessage'),
  sessionsBody: byId('sessionsBody'),
  sessionsHead: byId('sessionsHead'),

  earningsMeta: byId('earningsMeta'),
  earningsMessage: byId('earningsMessage'),
  earnToday: byId('earnToday'),
  earnWeek: byId('earnWeek'),
  earnMonth: byId('earnMonth'),
  earningsLineChart: byId('earningsLineChart'),
  earningsPieChart: byId('earningsPieChart'),

  // Wallet
  walletMeta: byId('walletMeta'),
  walletMessage: byId('walletMessage'),
  walletAddress: byId('walletAddress'),
  walletCopyBtn: byId('walletCopyBtn'),
  walletChain: byId('walletChain'),
  walletETH: byId('walletETH'),
  walletUSDC: byId('walletUSDC'),
  walletNetwork: byId('walletNetwork'),
  escrowDeposited: byId('escrowDeposited'),
  escrowCommitted: byId('escrowCommitted'),
  escrowAvailable: byId('escrowAvailable'),
  walletAmount: byId('walletAmount'),
  walletDepositBtn: byId('walletDepositBtn'),
  walletWithdrawBtn: byId('walletWithdrawBtn'),
  walletActionMessage: byId('walletActionMessage'),
  walletModeNode: byId('walletModeNode'),
  walletModeExternal: byId('walletModeExternal'),
  walletNodeSection: byId('walletNodeSection'),
  walletExternalSection: byId('walletExternalSection'),
  wcStatus: byId('wcStatus'),
  wcStatusText: byId('wcStatusText'),
  wcAddressRow: byId('wcAddressRow'),
  wcAddress: byId('wcAddress'),
  wcCopyBtn: byId('wcCopyBtn'),
  wcConnectBtn: byId('wcConnectBtn'),
  wcDisconnectBtn: byId('wcDisconnectBtn'),
  wcQrContainer: byId('wcQrContainer'),
  wcQrCanvas: byId('wcQrCanvas'),

  // AI Chat
  chatModelSelect: byId('chatModelSelect'),
  chatProxyStatus: byId('chatProxyStatus'),
  chatNewBtn: byId('chatNewBtn'),
  chatConversations: byId('chatConversations'),
  chatHeader: byId('chatHeader'),
  chatThreadMeta: byId('chatThreadMeta'),
  chatDeleteBtn: byId('chatDeleteBtn'),
  chatMessages: byId('chatMessages'),
  chatInput: byId('chatInput'),
  chatSendBtn: byId('chatSendBtn'),
  chatAbortBtn: byId('chatAbortBtn'),
  chatError: byId('chatError'),
  chatStreamingIndicator: byId('chatStreamingIndicator'),

  connectionMeta: byId('connectionMeta'),
  connectionStatus: byId('connectionStatus'),
  connectionNetwork: byId('connectionNetwork'),
  connectionSources: byId('connectionSources'),
  connectionNotes: byId('connectionNotes'),

  configMeta: byId('configMeta'),
  configMessage: byId('configMessage'),
  configSaveBtn: byId('configSaveBtn'),
  cfgReserveFloor: byId('cfgReserveFloor'),
  cfgSellerInputUsdPerMillion: byId('cfgSellerInputUsdPerMillion'),
  cfgSellerOutputUsdPerMillion: byId('cfgSellerOutputUsdPerMillion'),
  cfgMaxBuyers: byId('cfgMaxBuyers'),
  cfgProxyPort: byId('cfgProxyPort'),
  cfgPreferredProviders: byId('cfgPreferredProviders'),
  cfgBuyerMaxInputUsdPerMillion: byId('cfgBuyerMaxInputUsdPerMillion'),
  cfgBuyerMaxOutputUsdPerMillion: byId('cfgBuyerMaxOutputUsdPerMillion'),
  cfgMinRep: byId('cfgMinRep'),
  cfgPaymentMethod: byId('cfgPaymentMethod'),
};

const navButtons = Array.from(document.querySelectorAll<HTMLElement>('.sidebar-btn[data-view]'));
const views = Array.from(document.querySelectorAll<HTMLElement>('.view'));

const TOOLBAR_VIEWS = new Set(['overview', 'desktop']);

const {
  setActiveView,
  getActiveView,
  setAppMode,
  initNavigation,
  getSavedAppMode,
} = initNavigationModule({
  uiState,
  navButtons,
  views,
  toolbarViews: TOOLBAR_VIEWS,
  storageKey: 'antseed-app-mode',
});

function setBadgeTone(el, tone, label) {
  if (!el) return;
  el.classList.remove('badge-active', 'badge-idle', 'badge-warn', 'badge-bad');
  el.classList.add(`badge-${tone}`);
  el.textContent = label;
}

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

async function refreshAll() {
  if (!bridge || uiState.refreshing) {
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

function bindAction(buttonId, action, options = { refreshAfter: true }) {
  const button = byId(buttonId);
  if (!button) return;

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
      appendSystemLog(`Action failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      button.disabled = false;
    }
  });
}

async function waitForSeederReady(timeoutMs = 12000) {
  if (!bridge?.getState) {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const snapshot = await bridge.getState();
      const daemon = safeObject(snapshot?.daemonState);
      const daemonState = safeObject(daemon?.state);
      const mode = safeString(daemonState?.state, '');
      if (mode === 'seeding') {
        return true;
      }
    } catch {
      // Ignore transient bridge polling errors while waiting.
    }

    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  return false;
}

function bindControls() {
  bindAction('seedStartBtn', async () => {
    uiState.pluginHints.provider = null;
    saveSeedAuthPrefs();
    await bridge.start({
      mode: 'seed',
      provider: normalizeProviderRuntime(elements.seedProvider?.value),
      env: buildSeedRuntimeEnv(),
    });
  });

  bindAction('seedStopBtn', async () => {
    await bridge.stop('seed');
  });

  bindAction('connectStartBtn', async () => {
    uiState.pluginHints.router = null;
    if (isModeRunning('seed')) {
      const ready = await waitForSeederReady(10000);
      if (!ready) {
        appendSystemLog('Seeder is still warming up; buyer may not discover the local seller immediately.');
      }
    }
    await bridge.start({
      mode: 'connect',
      router: normalizeRouterRuntime(elements.connectRouter?.value),
    });
  });

  bindAction('connectStopBtn', async () => {
    await bridge.stop('connect');
  });

  bindAction('refreshBtn', refreshAll);

  bindAction('clearLogsBtn', async () => {
    await bridge.clearLogs();
  });

  bindAction('startAllBtn', async () => {
    let startedSeed = false;
    if (!isModeRunning('seed')) {
      saveSeedAuthPrefs();
      await bridge.start({
        mode: 'seed',
        provider: normalizeProviderRuntime(elements.seedProvider?.value),
        env: buildSeedRuntimeEnv(),
      });
      startedSeed = true;
    }

    if (startedSeed) {
      const ready = await waitForSeederReady(12000);
      if (!ready) {
        appendSystemLog('Seeder startup is taking longer than expected; buyer may not discover it immediately.');
      }
    }

    if (!isModeRunning('connect')) {
      await bridge.start({
        mode: 'connect',
        router: normalizeRouterRuntime(elements.connectRouter?.value),
      });
    }
  });

  bindAction('stopAllBtn', async () => {
    if (isModeRunning('connect')) {
      await bridge.stop('connect');
    }
    if (isModeRunning('seed')) {
      await bridge.stop('seed');
    }
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
    uiState.pluginHints.provider = null;
    renderPluginSetupState();
  });
  elements.connectRouter?.addEventListener('input', () => {
    uiState.pluginHints.router = null;
    renderPluginSetupState();
  });
}

function initializeBridge() {
  if (!bridge) {
    appendSystemLog('Desktop bridge unavailable: preload failed to inject API. Restart app after main/preload compile.');
    renderOfflineState('Desktop bridge unavailable.');
    return;
  }

  bridge.onLog((event) => {
    updatePluginHintFromLog(event);
    appendLog(event);
    renderPluginSetupState();
  });

  bridge.onState((processes) => {
    const wasDashboardRunning = uiState.dashboardRunning;
    renderProcesses(processes);

    if (isModeRunning('seed', processes)) {
      uiState.pluginHints.provider = null;
    }
    if (isModeRunning('connect', processes)) {
      uiState.pluginHints.router = null;
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
      const normalized = message.toLowerCase();
      if (normalized.includes('eaddrinuse') || normalized.includes('address already in use')) {
        appendSystemLog('Local data service port already in use; reusing the existing service.');
        return;
      }
      appendSystemLog(`Background data service start failed: ${message}`);
    });
  }

  void refreshAll();
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

const { refreshWalletInfo } = initWalletModule({
  bridge,
  elements,
  uiState,
  getDashboardPort,
  setText,
  setBadgeTone,
  safeString,
  formatMoney,
  getWalletActionResult,
});

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

function initPeriodToggle() {
  const buttons = document.querySelectorAll<HTMLElement>('.toggle-btn[data-period]');
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      uiState.earningsPeriod = btn.dataset.period;
      for (const b of buttons) {
        b.classList.toggle('active', b.dataset.period === uiState.earningsPeriod);
      }
      void refreshAll();
    });
  }
}

initNavigation();
setActiveView('overview');

// Restore persisted app mode
const savedMode = getSavedAppMode();
setAppMode(savedMode === 'connect' ? 'connect' : 'seeder');

renderPluginSetupState();
initSeedAuthControls();
bindControls();
initSortableHeaders();
bindPeerFilter();
initPeriodToggle();
initializeBridge();
