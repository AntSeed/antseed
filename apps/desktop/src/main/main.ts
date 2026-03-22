import {
  app,
  BrowserWindow,
  ipcMain,
} from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
  type StartOptions,
} from './process-manager.js';
import { registerPiChatHandlers } from './pi-chat-engine.js';
import { WalletConnectManager } from './walletconnect.js';
import { ensureSecureIdentity, secureIdentityEnv, getSecureIdentity } from './identity.js';
import type { LogEvent, RuntimeActivityEvent } from './log-parser.js';
import { parseRuntimeActivityFromLog } from './log-parser.js';
import {
  setPluginAppendLog,
  ensureDefaultPlugin,
  listInstalledPlugins,
  installPluginDependency,
  normalizePluginPackageName,
  isSafePluginPackageName,
  resolveLegacyPluginPackage,
  toNpmAliasInstallSpec,
  toFileInstallSpec,
  resolveLocalPluginSource,
  type InstalledPlugin,
} from './plugins.js';
type ApiResult = {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  status: number | null;
};
import {
  refreshPeerCache,
  getNetworkSnapshot,
  touchPeer,
  lookupPeer,
  onPeersChanged,
  type DashboardNetworkPeer,
} from './peer-cache.js';
import { createWindow, createApplicationMenu, getMainWindow } from './window.js';
import { ensureConfig, readConfig, mergeConfig, readNodeStatus } from './config-io.js';

// Re-export types that may be used by other main-process modules
export type { LogEvent, RuntimeActivityEvent } from './log-parser.js';
export type { DashboardNetworkPeer, DashboardNetworkStats, DashboardNetworkResult } from './peer-cache.js';
export type { InstalledPlugin } from './plugins.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = Boolean(process.env['VITE_DEV_SERVER_URL']);
const rendererUrl = process.env['VITE_DEV_SERVER_URL'] ?? `file://${path.join(__dirname, '../renderer/index.html')}`;
const APP_NAME = 'AntSeed Desktop';
const DESKTOP_DEBUG_ENV = 'ANTSEED_DESKTOP_DEBUG';
const DESKTOP_DEBUG_FLAGS = new Set(['--debug-runtime', '--desktop-debug']);

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function hasDesktopDebugFlag(argv: string[]): boolean {
  for (const arg of argv) {
    if (DESKTOP_DEBUG_FLAGS.has(arg.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

let desktopDebugEnabled = isTruthyEnv(process.env[DESKTOP_DEBUG_ENV]) || hasDesktopDebugFlag(process.argv);

function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.resolve(__dirname, '../../assets/antseed-dock-icon.png'),
    path.resolve(process.cwd(), 'assets/antseed-dock-icon.png'),
    path.resolve(__dirname, '../../assets/antseed-mark.png'),
    path.resolve(process.cwd(), 'assets/antseed-mark.png'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const APP_ICON_PATH = resolveAppIconPath();

// Set app name as early as possible; on macOS dev runs may still show "Electron"
// in some surfaces because the underlying bundle is Electron.app.
app.setName(APP_NAME);

import { DEFAULT_CONFIG_PATH } from './constants.js';
import { asRecord, asString } from './utils.js';

function resolveActiveConfigPath(): string {
  const explicit = process.env['ANTSEED_CONFIG_PATH']?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  return DEFAULT_CONFIG_PATH;
}

const ACTIVE_CONFIG_PATH = resolveActiveConfigPath();

const logBuffer: LogEvent[] = [];
let lastRuntimeActivityHash = '';

let appSetupNeeded = false;
let appSetupComplete = false;

function isPublicMetadataHost(rawHost: string): boolean {
  const host = rawHost.trim();
  if (host.length === 0 || host.includes('/') || host.includes('..') || host.includes('@')) {
    return false;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 4) {
    const parts = host.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return false;
    }
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 0) return false;
    return true;
  }

  const normalized = host.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('::ffff:')) {
    return false;
  }
  if (
    normalized.startsWith('fe80:')
    || normalized.startsWith('fe81:')
    || normalized.startsWith('fe82:')
    || normalized.startsWith('fe83:')
    || normalized.startsWith('fe84:')
    || normalized.startsWith('fe85:')
    || normalized.startsWith('fe86:')
    || normalized.startsWith('fe87:')
    || normalized.startsWith('fe88:')
    || normalized.startsWith('fe89:')
    || normalized.startsWith('fe8a:')
    || normalized.startsWith('fe8b:')
    || normalized.startsWith('fe8c:')
    || normalized.startsWith('fe8d:')
    || normalized.startsWith('fe8e:')
    || normalized.startsWith('fe8f:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
  ) {
    return false;
  }

  return true;
}

// ── Runtime Activity & Log Wiring ──

function emitRuntimeActivity(activity: RuntimeActivityEvent): void {
  const hash = [
    activity.mode,
    activity.stage,
    activity.tone,
    activity.message,
    activity.requestId ?? '',
    activity.peerId ?? '',
  ].join('|');

  if (hash === lastRuntimeActivityHash) {
    return;
  }
  lastRuntimeActivityHash = hash;
  getMainWindow()?.webContents.send('runtime:activity', activity);
}

function emitRuntimeState(): void {
  getMainWindow()?.webContents.send('runtime:state', getCombinedProcessState());
}

function appendLog(mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string): void {
  const event: LogEvent = { mode, stream, line, timestamp: Date.now() };
  logBuffer.push(event);
  if (logBuffer.length > 1200) {
    logBuffer.splice(0, logBuffer.length - 1200);
  }

  getMainWindow()?.webContents.send('runtime:log', event);
  const activity = parseRuntimeActivityFromLog(event);
  if (activity) {
    emitRuntimeActivity(activity);
  }
  emitRuntimeState();
}

// Wire up callbacks for extracted modules
setPluginAppendLog(appendLog);

// When the peer set changes, tell the renderer to refresh the service catalog.
onPeersChanged(() => {
  getMainWindow()?.webContents.send('peers:changed');
});
const processManager = new ProcessManager((mode, stream, line) => {
  appendLog(mode, stream, line);
});

function getCombinedProcessState(): RuntimeProcessState[] {
  return processManager.getState();
}

async function startDashboardRuntime(port?: number): Promise<void> {
  const targetPort = toSafeDashboardPort(port ?? dashboardRuntime.port);

  if (dashboardRuntime.running && dashboardRuntime.port === targetPort) {
    return;
  }
  if (dashboardStartPromise) {
    await dashboardStartPromise;
    if (dashboardRuntime.running && dashboardRuntime.port === targetPort) {
      return;
    }
  }

  const startAttempt = (async () => {
    if (dashboardRuntime.running) {
      await stopDashboardRuntime('restart');
    }

    dashboardRuntime.port = targetPort;
    dashboardRuntime.lastError = null;

    try {
      const config = await loadDashboardConfig(ACTIVE_CONFIG_PATH);
      dashboardServer = await createDashboardServer(config, targetPort, { configPath: ACTIVE_CONFIG_PATH });
      await dashboardServer.start();

      dashboardRuntime.running = true;
      dashboardRuntime.startedAt = Date.now();
      dashboardRuntime.lastExitCode = null;
      dashboardRuntime.lastError = null;
      dashboardPortInUseUntilMs = 0;

      appendLog('dashboard', 'system', `Embedded dashboard engine running on http://127.0.0.1:${targetPort}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dashboardRuntime.running = false;
      dashboardRuntime.startedAt = null;
      dashboardRuntime.lastExitCode = 1;
      dashboardRuntime.lastError = message;
      dashboardServer = null;

      if (isAddressInUseError(message)) {
        // Avoid startup log storms from parallel callers while still allowing a near-term retry.
        dashboardPortInUseUntilMs = Date.now() + DASHBOARD_PORT_IN_USE_RETRY_COOLDOWN_MS;
      }

      appendLog('dashboard', 'system', `Embedded dashboard engine failed to start: ${message}`);
      throw err;
    }
  })();

  dashboardStartPromise = startAttempt;
  try {
    await startAttempt;
  } finally {
    if (dashboardStartPromise === startAttempt) {
      dashboardStartPromise = null;
    }
  }
}

async function stopDashboardRuntime(reason: string): Promise<void> {
  if (!dashboardServer) {
    dashboardRuntime.running = false;
    dashboardRuntime.startedAt = null;
    emitRuntimeState();
    return;
  }

  try {
    await dashboardServer.stop();
    dashboardRuntime.lastExitCode = 0;
    appendLog('dashboard', 'system', `Embedded dashboard engine stopped (${reason}).`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dashboardRuntime.lastExitCode = 1;
    dashboardRuntime.lastError = message;
    appendLog('dashboard', 'system', `Embedded dashboard engine stop failed: ${message}`);
  } finally {
    dashboardServer = null;
    dashboardRuntime.running = false;
    dashboardRuntime.startedAt = null;
    emitRuntimeState();
  }
}

function createWindow(): void {
  const macosWindowChrome = process.platform === 'darwin'
    ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 14, y: 16 },
    }
    : {};

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: APP_NAME,
    icon: APP_ICON_PATH,
    backgroundColor: '#ececec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
    ...macosWindowChrome,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', false);
  });
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window-focus-change', true);
  });
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-focus-change', false);
  });

  void mainWindow.loadURL(rendererUrl);

  mainWindow.webContents.on('did-finish-load', () => {
    if (!isDev || !mainWindow) return;
    void mainWindow.webContents
      .executeJavaScript('Boolean(window.antseedDesktop)', true)
      .then((ok) => {
        console.log(`[desktop] preload bridge ${ok ? 'ready' : 'missing'}`);
      })
      .catch((err) => {
        console.error(`[desktop] preload bridge check failed: ${String(err)}`);
      });
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Allow opening DevTools in production for debugging (Cmd+Option+I / Ctrl+Shift+I).
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const devToolsShortcut =
      (input.meta && input.alt && input.key === 'i') ||   // macOS: Cmd+Option+I
      (input.control && input.shift && input.key === 'I'); // Windows/Linux: Ctrl+Shift+I
    if (devToolsShortcut && mainWindow) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showAboutDialog(): void {
  void dialog.showMessageBox({
    type: 'none',
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail: `Version ${app.getVersion()}`,
    buttons: ['OK'],
    icon: APP_ICON_PATH ? nativeImage.createFromPath(APP_ICON_PATH) : undefined,
  });
}

function createApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
      {
        label: APP_NAME,
        submenu: [
          { label: `About ${APP_NAME}`, click: () => showAboutDialog() },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${APP_NAME}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${APP_NAME}` },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: `About ${APP_NAME}`, click: () => showAboutDialog() },
        ],
      },
    ]
    : [
      {
        role: 'fileMenu',
      },
      {
        role: 'editMenu',
      },
      {
        role: 'viewMenu',
      },
      {
        role: 'windowMenu',
      },
      {
        role: 'help',
        submenu: [
          { label: `About ${APP_NAME}`, click: () => showAboutDialog() },
        ],
      },
    ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function defaultNetworkStats(): DashboardNetworkStats {
  return {
    totalPeers: 0,
    dhtNodeCount: 0,
    dhtHealthy: false,
    lastScanAt: null,
    totalLookups: 0,
    successfulLookups: 0,
    lookupSuccessRate: 0,
    averageLookupLatencyMs: 0,
    healthReason: 'dashboard offline',
  };
}

function toSafeDashboardEndpoint(endpoint: string): DashboardEndpoint | null {
  if (DASHBOARD_ENDPOINTS.has(endpoint as DashboardEndpoint)) {
    return endpoint as DashboardEndpoint;
  }
  return null;
}

function sanitizeDashboardQuery(query: unknown): Record<string, DashboardQueryValue> {
  if (!query || typeof query !== 'object') {
    return {};
  }

  const safe: Record<string, DashboardQueryValue> = {};
  for (const [rawKey, rawValue] of Object.entries(query)) {
    const key = rawKey.trim();
    if (key.length === 0) {
      continue;
    }
    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      safe[key] = rawValue;
    }
  }
  return safe;
}

const DASHBOARD_FETCH_TIMEOUT_MS = 10_000;

function buildDashboardUrl(endpoint: DashboardEndpoint, port: number, query: Record<string, DashboardQueryValue>): string {
  const url = new URL(`http://127.0.0.1:${port}/api/${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function errorMessageFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = (payload as { error?: unknown }).error;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate;
  }
  return null;
}

async function fetchDashboardData(
  endpoint: DashboardEndpoint,
  port?: number,
  query: Record<string, DashboardQueryValue> = {},
): Promise<DashboardApiResult> {
  const safePort = toSafeDashboardPort(port);
  const url = buildDashboardUrl(endpoint, safePort, query);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DASHBOARD_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    let payload: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      return {
        ok: false,
        data: payload,
        error: errorMessageFromPayload(payload) ?? `dashboard api returned ${response.status}`,
        status: response.status,
      };
    }

    return {
      ok: true,
      data: payload,
      error: null,
      status: response.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    const error = normalized.includes('abort')
      ? `dashboard ${endpoint} request timed out after ${String(DASHBOARD_FETCH_TIMEOUT_MS)}ms`
      : message;
    return {
      ok: false,
      data: null,
      error,
      status: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function scanDashboardNetwork(port?: number): Promise<DashboardApiResult> {
  const safePort = toSafeDashboardPort(port);
  const url = `http://127.0.0.1:${safePort}/api/network/scan`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DASHBOARD_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      signal: controller.signal,
    });

    let payload: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      return {
        ok: false,
        data: payload,
        error: errorMessageFromPayload(payload) ?? `dashboard api returned ${response.status}`,
        status: response.status,
      };
    }

    return {
      ok: true,
      data: payload,
      error: null,
      status: response.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    const error = normalized.includes('abort')
      ? `dashboard network scan timed out after ${String(DASHBOARD_FETCH_TIMEOUT_MS)}ms`
      : message;
    return {
      ok: false,
      data: null,
      error,
      status: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function updateDashboardConfig(
  config: Record<string, unknown>,
  port?: number,
): Promise<DashboardApiResult> {
  const safePort = toSafeDashboardPort(port);
  const url = `http://127.0.0.1:${safePort}/api/config`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DASHBOARD_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(config),
      signal: controller.signal,
    });

    let payload: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      return {
        ok: false,
        data: payload,
        error: errorMessageFromPayload(payload) ?? `dashboard api returned ${response.status}`,
        status: response.status,
      };
    }

    return {
      ok: true,
      data: payload,
      error: null,
      status: response.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    const error = normalized.includes('abort')
      ? `dashboard config update timed out after ${String(DASHBOARD_FETCH_TIMEOUT_MS)}ms`
      : message;
    return {
      ok: false,
      data: null,
      error,
      status: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNetworkSnapshot(port?: number): Promise<DashboardNetworkResult> {
  const response = await fetchDashboardData('network', port);
  if (!response.ok || !response.data || typeof response.data !== 'object') {
    return {
      ok: false,
      peers: [],
      stats: defaultNetworkStats(),
      error: response.error ?? 'dashboard network api error',
    };
  }

  const payload = response.data as Partial<DashboardNetworkSnapshot>;
  const peers = Array.isArray(payload.peers) ? payload.peers : [];
  const stats = payload.stats ?? defaultNetworkStats();

  return {
    ok: true,
    peers,
    stats,
    error: null,
  };
}

async function ensureDashboardRuntime(targetPort?: number): Promise<void> {
  if (dashboardRuntime.running) {
    return;
  }

  const desiredPort = toSafeDashboardPort(targetPort ?? dashboardRuntime.port);
  const now = Date.now();
  if (dashboardPortInUseUntilMs > now && dashboardRuntime.port === desiredPort) {
    return;
  }

  try {
    await startDashboardRuntime(desiredPort);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAddressInUseError(message)) {
      appendLog('dashboard', 'system', `Dashboard port ${desiredPort} already in use; using existing local data service.`);
      return;
    }
    throw err;
  }
}

// ── IPC Handlers ──

ipcMain.handle('runtime:get-state', async () => {
  return {
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
    logs: [...logBuffer],
  };
});

ipcMain.handle('runtime:start', async (_event, options: StartOptions) => {
  await ensureSecureIdentity();

  const startOptions: StartOptions = {
    ...options,
    ...(desktopDebugEnabled ? { verbose: true } : {}),
    env: {
      ...(options.env ?? {}),
      ...(desktopDebugEnabled ? { ANTSEED_DEBUG: '1' } : {}),
      ...secureIdentityEnv(),
    },
  };
  if (desktopDebugEnabled) {
    appendLog(startOptions.mode, 'system', 'Desktop debug mode enabled (ANTSEED_DEBUG=1, --verbose).');
  }

  const state = await processManager.start(startOptions);
  return {
    state,
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
  };
});

ipcMain.handle('runtime:stop', async (_event, mode: RuntimeMode) => {
  const state = await processManager.stop(mode);
  return {
    state,
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
  };
});

ipcMain.handle('desktop:set-debug-logs', (_event, enabled: boolean) => {
  desktopDebugEnabled = Boolean(enabled);
  return { ok: true };
});

ipcMain.handle('runtime:clear-logs', async () => {
  logBuffer.length = 0;
  return { ok: true };
});

ipcMain.handle('app:get-setup-status', () => ({
  needed: appSetupNeeded,
  complete: appSetupComplete,
}));

ipcMain.handle('identity:get', async () => {
  try {
    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    if (!identity) {
      return { ok: false, data: null, error: 'Identity not available (safeStorage may not be ready)' };
    }
    return {
      ok: true,
      data: { peerId: identity.peerId },
      error: null,
    };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('plugins:list', async () => {
  try {
    const plugins = await listInstalledPlugins();
    return { ok: true, plugins, error: null };
  } catch (err) {
    return {
      ok: false,
      plugins: [] as InstalledPlugin[],
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle('plugins:install', async (_event, packageName: string) => {
  const normalized = typeof packageName === 'string' ? normalizePluginPackageName(packageName) : '';
  if (!normalized || !isSafePluginPackageName(normalized)) {
    return {
      ok: false,
      package: normalized,
      plugins: [] as InstalledPlugin[],
      error: `Invalid plugin package name: ${packageName}`,
    };
  }

  try {
    appendLog('connect', 'system', `Installing plugin "${normalized}"...`);
    await installPluginDependency(normalized);
    const plugins = await listInstalledPlugins();
    appendLog('connect', 'system', `Installed plugin "${normalized}".`);
    return { ok: true, package: normalized, plugins, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const legacyPackageName = resolveLegacyPluginPackage(normalized);

    if (legacyPackageName) {
      try {
        const aliasSpec = toNpmAliasInstallSpec(normalized, legacyPackageName);
        appendLog('connect', 'system', `Registry install failed; retrying via legacy alias: ${aliasSpec}`);
        await installPluginDependency(aliasSpec);
        const plugins = await listInstalledPlugins();
        appendLog('connect', 'system', `Installed plugin "${normalized}" using legacy package alias "${legacyPackageName}".`);
        return { ok: true, package: normalized, plugins, error: null };
      } catch (legacyErr) {
        const legacyMessage = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        appendLog('connect', 'system', `Legacy alias install failed for "${normalized}": ${legacyMessage}`);
      }
    }

    const localSource = await resolveLocalPluginSource(normalized);

    if (localSource) {
      try {
        appendLog('connect', 'system', `Registry install failed; retrying from local source: ${localSource}`);
        await installPluginDependency(toFileInstallSpec(normalized, localSource));
        const plugins = await listInstalledPlugins();
        appendLog('connect', 'system', `Installed plugin "${normalized}" from local source.`);
        return { ok: true, package: normalized, plugins, error: null };
      } catch (localErr) {
        const localMessage = localErr instanceof Error ? localErr.message : String(localErr);
        appendLog('connect', 'system', `Local plugin install failed for "${normalized}": ${localMessage}`);
        return {
          ok: false,
          package: normalized,
          plugins: await listInstalledPlugins(),
          error: `Registry install failed: ${message}\nLocal fallback failed: ${localMessage}`,
        };
      }
    }

    appendLog('connect', 'system', `Plugin install failed for "${normalized}": ${message}`);
    return {
      ok: false,
      package: normalized,
      plugins: await listInstalledPlugins(),
      error: message,
    };
  }
});

ipcMain.handle('runtime:get-network', async () => {
  await refreshPeerCache();
  return getNetworkSnapshot();
});

ipcMain.handle('runtime:lookup-peer', async (_event, peerId: string) => {
  if (typeof peerId !== 'string' || peerId.trim().length === 0) {
    return { ok: false, peer: null, error: 'Invalid peerId' };
  }
  await refreshPeerCache();
  const peer = lookupPeer(peerId.trim());
  return { ok: Boolean(peer), peer, error: peer ? null : 'Peer not found' };
});

ipcMain.handle('runtime:touch-peer', (_event, peerId: string) => {
  if (typeof peerId !== 'string' || peerId.trim().length === 0) return { ok: false };
  return { ok: touchPeer(peerId.trim()) };
});

ipcMain.handle(
  'runtime:get-data',
  async (
    _event,
    endpoint: string,
    _options?: { port?: number; query?: Record<string, unknown> },
  ) => {
    // Serve status, config, and network directly from files — no dashboard needed.
    if (endpoint === 'status') {
      try {
        const data = await readNodeStatus(ACTIVE_CONFIG_PATH);
        return { ok: true, data, error: null, status: 200 } satisfies ApiResult;
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null } satisfies ApiResult;
      }
    }

    if (endpoint === 'config') {
      try {
        const config = await readConfig(ACTIVE_CONFIG_PATH);
        return { ok: true, data: { config }, error: null, status: 200 } satisfies ApiResult;
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null } satisfies ApiResult;
      }
    }

    if (endpoint === 'network' || endpoint === 'peers') {
      try {
        await refreshPeerCache();
        const snapshot = getNetworkSnapshot();
        if (endpoint === 'peers') {
          return { ok: true, data: { peers: snapshot.peers, total: snapshot.peers.length, degraded: false }, error: null, status: 200 } satisfies ApiResult;
        }
      return { ok: true, data: snapshot, error: null, status: 200 } satisfies ApiResult;
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null } satisfies ApiResult;
      }
    }

    if (endpoint === 'data-sources') {
      return { ok: true, data: { configPath: ACTIVE_CONFIG_PATH }, error: null, status: 200 } satisfies ApiResult;
    }

    // Sessions/earnings are seller-only — not needed in the desktop (buyer) app.
    return {
      ok: false,
      data: null,
      error: `Endpoint "${endpoint}" is not available in the desktop app`,
      status: null,
    } satisfies ApiResult;
  },
);

// Allowlisted top-level keys that the renderer is permitted to update via IPC.
// Any key not in this set is stripped before the request is forwarded to the
// dashboard API, preventing a compromised renderer from overwriting arbitrary
// config fields.
const DASHBOARD_CONFIG_ALLOWED_KEYS = new Set([
  'seller',
  'buyer',
  'identity',
  'network',
  'payments',
]);

function sanitizeDashboardConfigPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (DASHBOARD_CONFIG_ALLOWED_KEYS.has(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

ipcMain.handle(
  'runtime:update-config',
  async (_event, config: Record<string, unknown>): Promise<ApiResult> => {
    const safeConfig = sanitizeDashboardConfigPayload(config);
    if (Object.keys(safeConfig).length === 0) {
      return { ok: false, data: null, error: 'No valid config keys provided', status: null };
    }
    try {
      const merged = await mergeConfig(safeConfig, ACTIVE_CONFIG_PATH);
      return { ok: true, data: { config: merged }, error: null, status: 200 };
    } catch (err) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null };
    }
  },
);

// ── Wallet IPC Handlers ──

type WalletInfo = {
  address: string | null;
  chainId: string;
  balanceETH: string;
  balanceUSDC: string;
  escrow: {
    deposited: string;
    committed: string;
    available: string;
  };
};

ipcMain.handle('wallet:get-info', async (): Promise<{ ok: boolean; data: WalletInfo | null; error: string | null }> => {
  try {
    const [status, config] = await Promise.all([
      readNodeStatus(ACTIVE_CONFIG_PATH),
      readConfig(ACTIVE_CONFIG_PATH),
    ]);

    const identity = asRecord(config.identity);
    const payments = asRecord(config.payments);
    const walletAddress = asString(status.walletAddress as string, '') || asString(identity.walletAddress as string, '');

    return {
      ok: true,
      data: {
        address: walletAddress || null,
        chainId: asString(payments.chainId as string, 'base-sepolia'),
        balanceETH: '0.00',
        balanceUSDC: '0.00',
        escrow: {
          deposited: '0.00',
          committed: '0.00',
          available: '0.00',
        },
      },
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle('wallet:deposit', async (_event, amount: string) => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { ok: false, error: 'Invalid deposit amount' };
  }
  appendLog('connect', 'system', `Deposit requested: ${amount} USDC. Run 'antseed deposit ${amount}' in terminal.`);
  return { ok: true, message: `Deposit of ${amount} USDC logged. Use CLI to execute: antseed deposit ${amount}` };
});

ipcMain.handle('wallet:withdraw', async (_event, amount: string) => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { ok: false, error: 'Invalid withdrawal amount' };
  }
  appendLog('connect', 'system', `Withdrawal requested: ${amount} USDC. Run 'antseed withdraw ${amount}' in terminal.`);
  return { ok: true, message: `Withdrawal of ${amount} USDC logged. Use CLI to execute: antseed withdraw ${amount}` };
});

// ── WalletConnect IPC Handlers ──

const walletConnectManager = new WalletConnectManager();

walletConnectManager.on('state', (state: unknown) => {
  getMainWindow()?.webContents.send('wallet:wc-state-changed', state);
});

ipcMain.handle('wallet:wc-state', async () => {
  return { ok: true, data: walletConnectManager.state };
});

ipcMain.handle('wallet:wc-connect', async () => {
  try {
    const uri = await walletConnectManager.connect();
    if (!uri) {
      return { ok: false, error: 'WalletConnect not initialized. Set WALLETCONNECT_PROJECT_ID environment variable.' };
    }
    return { ok: true, data: { uri } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('wallet:wc-disconnect', async () => {
  try {
    await walletConnectManager.disconnect();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── AI Chat IPC Handlers ──
registerPiChatHandlers({
  ipcMain,
  sendToRenderer: (channel, payload) => {
    getMainWindow()?.webContents.send(channel, payload);
  },
  configPath: ACTIVE_CONFIG_PATH,
  isBuyerRuntimeRunning: () => getCombinedProcessState().some((state) => state.mode === "connect" && state.running),
  ensureBuyerRuntimeStarted: async () => {
    const connectState = getCombinedProcessState().find((state) => state.mode === 'connect');
    if (connectState?.running) {
      return true;
    }

    await ensureSecureIdentity();

    const startOptions: StartOptions = {
      mode: 'connect',
      router: 'local',
      ...(desktopDebugEnabled ? { verbose: true } : {}),
      env: {
        ...(desktopDebugEnabled ? { ANTSEED_DEBUG: '1' } : {}),
        ...secureIdentityEnv(),
      },
    };

    try {
      await processManager.start(startOptions);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('already running')) {
        return true;
      }
      appendLog('connect', 'system', `Chat-triggered buyer runtime start failed: ${message}`);
      return false;
    }
  },
  appendSystemLog: (line) => {
    appendLog("connect", "system", line);
  },
  getNetworkPeers: async () => {
    await refreshPeerCache();
    const snapshot = getNetworkSnapshot();
    if (!snapshot.ok) {
      return [];
    }
    return snapshot.peers
      .map((peer: DashboardNetworkPeer) => ({
        peerId: typeof peer.peerId === "string" ? peer.peerId : "",
        displayName: peer.displayName ?? undefined,
        host: typeof peer.host === "string" ? peer.host.trim() : "",
        port: Number(peer.port) || 0,
        providers: Array.isArray(peer.providers) ? peer.providers.map((provider) => String(provider)) : [],
        services: Array.isArray(peer.services) ? peer.services.map((s) => String(s)) : [],
      }))
      .filter((peer) => peer.host.length > 0
        && isPublicMetadataHost(peer.host)
        && peer.port > 0
        && peer.port <= 65535);
  },
});

ipcMain.handle('runtime:scan-network', async () => {
  // The buyer runtime handles peer discovery; just return the current state.
  await refreshPeerCache();
  const snapshot = getNetworkSnapshot();
  return { ok: snapshot.ok, data: snapshot, error: snapshot.error, status: 200 };
});

app.whenReady().then(() => {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    iconPath: APP_ICON_PATH,
  });
  if (process.platform === 'darwin' && APP_ICON_PATH && app.dock) {
    app.dock.setIcon(APP_ICON_PATH);
  }
  createApplicationMenu(APP_NAME, APP_ICON_PATH);

  // Ensure config.json exists before anything else (first launch).
  void ensureConfig(ACTIVE_CONFIG_PATH).catch(() => {});

  createWindow({ appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl });

  // Pre-load identity from encrypted store so it's ready before the first CLI spawn.
  void ensureSecureIdentity().catch(() => {
    // Failure is logged inside ensureSecureIdentity; CLI falls back to file-based identity.
  });

  void ensureDefaultPlugin('@antseed/router-local', {
    getAppSetupNeeded: () => appSetupNeeded,
    setAppSetupNeeded: (v) => { appSetupNeeded = v; },
    getAppSetupComplete: () => appSetupComplete,
    setAppSetupComplete: (v) => { appSetupComplete = v; },
    getMainWindow,
    appendLog,
  }).catch(() => {
    // Failure is already logged via appendLog inside ensureDefaultPlugin.
  });

  // Auto-update: check for updates silently on launch and every 4 hours
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

  autoUpdater.on('update-downloaded', (info) => {
    getMainWindow()?.webContents.send('app:update-status', { status: 'ready', version: info.version });
    if (updateCheckInterval) {
      clearInterval(updateCheckInterval);
      updateCheckInterval = null;
    }
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error:', err?.message ?? err);
  });

  void autoUpdater.checkForUpdates().catch(() => {});

  updateCheckInterval = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);

  ipcMain.handle('app:install-update', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Initialize WalletConnect if project ID is configured
  const wcProjectId = process.env['WALLETCONNECT_PROJECT_ID'] ?? '';
  if (wcProjectId.length > 0) {
    void walletConnectManager.init(wcProjectId).catch((err) => {
      console.error('[WalletConnect] init failed:', err instanceof Error ? err.message : String(err));
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow({ appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void processManager.stopAll().finally(() => app.quit());
  }
});

let isQuitting = false;

app.on('before-quit', (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  isQuitting = true;

  void processManager.stopAll().finally(() => {
    app.quit();
  });
});

// Ensure child processes are cleaned up if the main process receives SIGTERM
// (e.g. dev runner Ctrl+C kills Electron before before-quit fires).
process.on('SIGTERM', () => {
  void processManager.stopAll().finally(() => process.exit(0));
});
