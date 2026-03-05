import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  dialog,
  nativeImage,
  type MenuItemConstructorOptions,
} from 'electron';
import { readFile, writeFile, readdir, unlink, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { createDashboardServer, type DashboardConfig, type DashboardServer } from '@antseed/dashboard';
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
  type StartOptions,
} from './process-manager.js';
import { registerPiChatHandlers } from './pi-chat-engine.js';
import { WalletConnectManager } from './walletconnect.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFileCallback);

const isDev = Boolean(process.env['VITE_DEV_SERVER_URL']);
const rendererUrl = process.env['VITE_DEV_SERVER_URL'] ?? `file://${path.join(__dirname, '../renderer/index.html')}`;
const APP_NAME = 'AntSeed Desktop';

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

type LogEvent = {
  mode: RuntimeMode;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  timestamp: number;
};

type DashboardNetworkPeer = {
  peerId: string;
  host: string;
  port: number;
  providers: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: 'dht' | 'daemon';
};

type DashboardNetworkStats = {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
  totalLookups?: number;
  successfulLookups?: number;
  lookupSuccessRate?: number;
  averageLookupLatencyMs?: number;
  healthReason?: string;
};

type DashboardNetworkSnapshot = {
  peers: DashboardNetworkPeer[];
  stats: DashboardNetworkStats;
};

type DashboardNetworkResult = {
  ok: boolean;
  peers: DashboardNetworkPeer[];
  stats: DashboardNetworkStats;
  error: string | null;
};

type DashboardEndpoint = 'status' | 'network' | 'peers' | 'sessions' | 'earnings' | 'config' | 'data-sources';

type DashboardQueryValue = string | number | boolean;

type DashboardApiResult = {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  status: number | null;
};

type DashboardRuntimeState = {
  running: boolean;
  port: number;
  startedAt: number | null;
  lastError: string | null;
  lastExitCode: number | null;
};

type InstalledPlugin = {
  package: string;
  version: string;
};

const DEFAULT_DASHBOARD_PORT = 3117;
const DEFAULT_CONFIG_PATH = path.join(homedir(), '.antseed', 'config.json');
const DEFAULT_PLUGINS_DIR = path.join(homedir(), '.antseed', 'plugins');
const DEFAULT_PLUGINS_PACKAGE_JSON = path.join(DEFAULT_PLUGINS_DIR, 'package.json');
const SAFE_PLUGIN_PACKAGE_PATTERN = /^(@?[a-z0-9][a-z0-9._-]*)(\/[a-z0-9][a-z0-9._-]*)?$/i;
const PLUGIN_PACKAGE_ALIAS_MAP: Record<string, string> = {
  anthropic: '@antseed/provider-anthropic',
  openai: '@antseed/provider-openai',
  'local-llm': '@antseed/provider-local-llm',
  'provider-anthropic': '@antseed/provider-anthropic',
  'provider-openai': '@antseed/provider-openai',
  'provider-local-llm': '@antseed/provider-local-llm',
  'antseed-provider-anthropic': '@antseed/provider-anthropic',
  'antseed-provider-openai': '@antseed/provider-openai',
  'antseed-provider-local-llm': '@antseed/provider-local-llm',
  'claude-code': '@antseed/provider-claude-code',
  'provider-claude-code': '@antseed/provider-claude-code',
  'antseed-provider-claude-code': '@antseed/provider-claude-code',
  'claude-oauth': '@antseed/provider-claude-oauth',
  'provider-claude-oauth': '@antseed/provider-claude-oauth',
  'local': '@antseed/router-local',
  'router-local': '@antseed/router-local',
  'antseed-router-claude-code': '@antseed/router-local',
  'antseed-router-local': '@antseed/router-local',
};
const SCOPED_TO_LEGACY_PLUGIN_PACKAGE_MAP: Record<string, string> = {
  '@antseed/provider-anthropic': 'antseed-provider-anthropic',
  '@antseed/provider-openai': 'antseed-provider-openai',
  '@antseed/provider-local-llm': 'antseed-provider-local-llm',
  '@antseed/provider-claude-code': 'antseed-provider-claude-code',
  '@antseed/provider-claude-oauth': 'antseed-provider-claude-oauth',
  '@antseed/router-local': 'antseed-router-local',
};

function resolveActiveConfigPath(): string {
  const explicit = process.env['ANTSEED_CONFIG_PATH']?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  return DEFAULT_CONFIG_PATH;
}

const ACTIVE_CONFIG_PATH = resolveActiveConfigPath();

const DASHBOARD_ENDPOINTS: ReadonlySet<DashboardEndpoint> = new Set([
  'status',
  'network',
  'peers',
  'sessions',
  'earnings',
  'config',
  'data-sources',
]);

let mainWindow: BrowserWindow | null = null;
const logBuffer: LogEvent[] = [];

let dashboardServer: DashboardServer | null = null;
const dashboardRuntime: DashboardRuntimeState = {
  running: false,
  port: DEFAULT_DASHBOARD_PORT,
  startedAt: null,
  lastError: null,
  lastExitCode: null,
};

function toSafeDashboardPort(port?: number): number {
  const parsed = Number(port);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
    return Math.floor(parsed);
  }
  return DEFAULT_DASHBOARD_PORT;
}

function isAddressInUseError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('eaddrinuse') || normalized.includes('address already in use');
}

function appendLog(mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string): void {
  const event: LogEvent = { mode, stream, line, timestamp: Date.now() };
  logBuffer.push(event);
  if (logBuffer.length > 1200) {
    logBuffer.splice(0, logBuffer.length - 1200);
  }

  mainWindow?.webContents.send('runtime:log', event);
  emitRuntimeState();
}

const processManager = new ProcessManager((mode, stream, line) => {
  appendLog(mode, stream, line);
});

function getDashboardProcessState(): RuntimeProcessState {
  return {
    mode: 'dashboard',
    running: dashboardRuntime.running,
    pid: dashboardRuntime.running ? process.pid : null,
    startedAt: dashboardRuntime.startedAt,
    lastExitCode: dashboardRuntime.lastExitCode,
    lastError: dashboardRuntime.lastError,
  };
}

function getCombinedProcessState(): RuntimeProcessState[] {
  const processStates = processManager.getState().filter((state) => state.mode !== 'dashboard');
  processStates.push(getDashboardProcessState());
  return processStates;
}

function emitRuntimeState(): void {
  mainWindow?.webContents.send('runtime:state', getCombinedProcessState());
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function isSafePluginPackageName(value: string): boolean {
  return SAFE_PLUGIN_PACKAGE_PATTERN.test(value);
}

function normalizePluginPackageName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();
  if (PLUGIN_PACKAGE_ALIAS_MAP[lower]) {
    return PLUGIN_PACKAGE_ALIAS_MAP[lower]!;
  }

  if (trimmed.startsWith('@')) {
    return trimmed;
  }

  if (lower.startsWith('provider-') || lower.startsWith('router-')) {
    return `@antseed/${lower}`;
  }

  return trimmed;
}

function resolveLegacyPluginPackage(packageName: string): string | null {
  return SCOPED_TO_LEGACY_PLUGIN_PACKAGE_MAP[packageName] ?? null;
}

function resolveLocalPackageNameAliases(packageName: string): Set<string> {
  const aliases = new Set<string>([packageName]);
  for (const [scoped, legacy] of Object.entries(SCOPED_TO_LEGACY_PLUGIN_PACKAGE_MAP)) {
    if (packageName === scoped) {
      aliases.add(legacy);
    } else if (packageName === legacy) {
      aliases.add(scoped);
    }
  }
  return aliases;
}

function toFileInstallSpec(packageName: string, localPath: string): string {
  const normalizedPath = localPath.startsWith('file:') ? localPath.slice(5) : localPath;
  return `${packageName}@file:${normalizedPath}`;
}

function toNpmAliasInstallSpec(packageName: string, legacyPackageName: string): string {
  return `${packageName}@npm:${legacyPackageName}`;
}

async function ensurePluginsDirectory(): Promise<void> {
  await mkdir(DEFAULT_PLUGINS_DIR, { recursive: true });

  if (!existsSync(DEFAULT_PLUGINS_PACKAGE_JSON)) {
    const emptyPackageJson = {
      name: 'antseed-plugins',
      version: '1.0.0',
      private: true,
      dependencies: {},
    };
    await writeFile(DEFAULT_PLUGINS_PACKAGE_JSON, JSON.stringify(emptyPackageJson, null, 2), 'utf-8');
  }
}

async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  await ensurePluginsDirectory();

  try {
    const raw = await readFile(DEFAULT_PLUGINS_PACKAGE_JSON, 'utf-8');
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const deps = parsed.dependencies ?? {};
    return Object.entries(deps)
      .map(([pkg, version]) => ({ package: pkg, version }))
      .sort((left, right) => left.package.localeCompare(right.package));
  } catch {
    return [];
  }
}

async function installPluginDependency(packageSpec: string): Promise<void> {
  await ensurePluginsDirectory();
  await execFileAsync('npm', ['install', '--ignore-scripts', packageSpec], {
    cwd: DEFAULT_PLUGINS_DIR,
  });
}

async function resolveLocalPluginSource(packageName: string): Promise<string | null> {
  const rootCandidates = [
    path.resolve(process.cwd(), '..'),
    path.resolve(__dirname, '../../../'),
  ];

  const dedupedRoots = [...new Set(rootCandidates)];
  const acceptedPackageNames = resolveLocalPackageNameAliases(packageName);
  const packageSuffix = packageName.includes('/') ? packageName.split('/').pop() ?? packageName : packageName;
  const inferredDir = packageSuffix.replace(/^antseed-/, '');

  const relativeCandidates = [
    packageName,
    packageSuffix,
    inferredDir,
    `plugins/${packageSuffix}`,
    `plugins/${inferredDir}`,
  ];

  for (const root of dedupedRoots) {
    for (const rel of relativeCandidates) {
      const candidateDir = path.resolve(root, rel);
      const packageJsonPath = path.join(candidateDir, 'package.json');
      if (!existsSync(packageJsonPath)) {
        continue;
      }

      try {
        const raw = await readFile(packageJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (typeof parsed.name === 'string' && acceptedPackageNames.has(parsed.name.trim())) {
          return candidateDir;
        }
      } catch {
        // Ignore unreadable candidates and continue.
      }
    }
  }

  for (const root of dedupedRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name.startsWith('.')) {
          continue;
        }
        const candidateDir = path.join(root, entry.name);
        const packageJsonPath = path.join(candidateDir, 'package.json');
        if (!existsSync(packageJsonPath)) {
          continue;
        }

        try {
          const raw = await readFile(packageJsonPath, 'utf-8');
          const parsed = JSON.parse(raw) as { name?: unknown };
          if (typeof parsed.name === 'string' && acceptedPackageNames.has(parsed.name.trim())) {
            return candidateDir;
          }
        } catch {
          // Ignore unreadable candidates and continue.
        }
      }
    } catch {
      // Ignore unreadable roots.
    }
  }

  return null;
}

function defaultDashboardConfig(): DashboardConfig {
  return {
    identity: {
      displayName: 'AntSeed Node',
    },
    seller: {
      reserveFloor: 10,
      maxConcurrentBuyers: 5,
      enabledProviders: [],
      pricing: {
        defaults: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
        },
      },
    },
    buyer: {
      preferredProviders: ['anthropic', 'openai', 'claude-code', 'claude-oauth', 'local-llm'],
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 100,
          outputUsdPerMillion: 100,
        },
      },
      minPeerReputation: 50,
      proxyPort: 8377,
    },
    network: {
      bootstrapNodes: [],
    },
    payments: {
      preferredMethod: 'crypto',
      platformFeeRate: 0.05,
    },
    providers: [],
    plugins: [],
  };
}

async function loadDashboardConfig(configPath = DEFAULT_CONFIG_PATH): Promise<DashboardConfig> {
  const defaults = defaultDashboardConfig();

  let parsed: unknown;
  try {
    const raw = await readFile(configPath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }

  const root = asRecord(parsed);
  const identity = asRecord(root.identity);
  const seller = asRecord(root.seller);
  const buyer = asRecord(root.buyer);
  const sellerPricing = asRecord(seller.pricing);
  const sellerPricingDefaults = asRecord(sellerPricing.defaults);
  const buyerMaxPricing = asRecord(buyer.maxPricing);
  const buyerMaxPricingDefaults = asRecord(buyerMaxPricing.defaults);
  const network = asRecord(root.network);
  const payments = asRecord(root.payments);

  const plugins = Array.isArray(root.plugins)
    ? root.plugins
      .map((item) => asRecord(item))
      .map((item) => ({
        name: asString(item.name, 'unknown'),
        package: asString(item.package, 'unknown'),
        installedAt: asString(item.installedAt, new Date(0).toISOString()),
      }))
    : [];

  return {
    identity: {
      displayName: asString(identity.displayName, defaults.identity.displayName),
      walletAddress: typeof identity.walletAddress === 'string' ? identity.walletAddress : undefined,
    },
    seller: {
      reserveFloor: asNumber(seller.reserveFloor, defaults.seller.reserveFloor),
      maxConcurrentBuyers: asNumber(seller.maxConcurrentBuyers, defaults.seller.maxConcurrentBuyers),
      enabledProviders: asStringArray(seller.enabledProviders, defaults.seller.enabledProviders),
      pricing: {
        defaults: {
          inputUsdPerMillion: asNumber(
            sellerPricingDefaults.inputUsdPerMillion,
            defaults.seller.pricing.defaults.inputUsdPerMillion
          ),
          outputUsdPerMillion: asNumber(
            sellerPricingDefaults.outputUsdPerMillion,
            defaults.seller.pricing.defaults.outputUsdPerMillion
          ),
        },
        providers: sellerPricing.providers && typeof sellerPricing.providers === 'object'
          ? sellerPricing.providers as DashboardConfig['seller']['pricing']['providers']
          : defaults.seller.pricing.providers,
      },
    },
    buyer: {
      preferredProviders: asStringArray(buyer.preferredProviders, defaults.buyer.preferredProviders),
      maxPricing: {
        defaults: {
          inputUsdPerMillion: asNumber(
            buyerMaxPricingDefaults.inputUsdPerMillion,
            defaults.buyer.maxPricing.defaults.inputUsdPerMillion
          ),
          outputUsdPerMillion: asNumber(
            buyerMaxPricingDefaults.outputUsdPerMillion,
            defaults.buyer.maxPricing.defaults.outputUsdPerMillion
          ),
        },
        providers: buyerMaxPricing.providers && typeof buyerMaxPricing.providers === 'object'
          ? buyerMaxPricing.providers as DashboardConfig['buyer']['maxPricing']['providers']
          : defaults.buyer.maxPricing.providers,
      },
      minPeerReputation: asNumber(buyer.minPeerReputation, defaults.buyer.minPeerReputation),
      proxyPort: asNumber(buyer.proxyPort, defaults.buyer.proxyPort),
    },
    network: {
      bootstrapNodes: asStringArray(network.bootstrapNodes, defaults.network.bootstrapNodes),
    },
    payments: {
      preferredMethod: asString(payments.preferredMethod, defaults.payments.preferredMethod),
      platformFeeRate: asNumber(payments.platformFeeRate, defaults.payments.platformFeeRate),
    },
    providers: Array.isArray(root.providers) ? root.providers : defaults.providers,
    plugins,
  };
}

async function startDashboardRuntime(port?: number): Promise<void> {
  const targetPort = toSafeDashboardPort(port ?? dashboardRuntime.port);

  if (dashboardRuntime.running && dashboardRuntime.port === targetPort) {
    return;
  }

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

    appendLog('dashboard', 'system', `Embedded dashboard engine running on http://127.0.0.1:${targetPort}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dashboardRuntime.running = false;
    dashboardRuntime.startedAt = null;
    dashboardRuntime.lastExitCode = 1;
    dashboardRuntime.lastError = message;
    dashboardServer = null;

    appendLog('dashboard', 'system', `Embedded dashboard engine failed to start: ${message}`);
    throw err;
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
      titleBarStyle: 'hidden' as const,
      trafficLightPosition: { x: 14, y: 14 },
    }
    : {};

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: APP_NAME,
    icon: APP_ICON_PATH,
    backgroundColor: '#080c12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...macosWindowChrome,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
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

  try {
    const response = await fetch(url);

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
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      status: null,
    };
  }
}

async function scanDashboardNetwork(port?: number): Promise<DashboardApiResult> {
  const safePort = toSafeDashboardPort(port);
  const url = `http://127.0.0.1:${safePort}/api/network/scan`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
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
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      status: null,
    };
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
  const lastError = dashboardRuntime.lastError ?? '';
  if (isAddressInUseError(lastError) && dashboardRuntime.port === desiredPort) {
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

ipcMain.handle('runtime:get-state', async () => {
  return {
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
    logs: [...logBuffer],
  };
});

ipcMain.handle('runtime:start', async (_event, options: StartOptions) => {
  if (options.mode === 'dashboard') {
    try {
      await startDashboardRuntime(options.dashboardPort);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isAddressInUseError(message)) {
        throw err;
      }
      appendLog('dashboard', 'system', 'Dashboard port already in use; reusing existing local data service.');
    }
    return {
      state: getDashboardProcessState(),
      processes: getCombinedProcessState(),
      daemonState: processManager.getDaemonStateSnapshot(),
    };
  }

  const state = await processManager.start(options);
  return {
    state,
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
  };
});

ipcMain.handle('runtime:stop', async (_event, mode: RuntimeMode) => {
  if (mode === 'dashboard') {
    await stopDashboardRuntime('manual stop');
    return {
      state: getDashboardProcessState(),
      processes: getCombinedProcessState(),
      daemonState: processManager.getDaemonStateSnapshot(),
    };
  }

  const state = await processManager.stop(mode);
  return {
    state,
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
  };
});

ipcMain.handle('runtime:open-dashboard', async (_event, port?: number) => {
  const openPort = dashboardRuntime.running ? dashboardRuntime.port : toSafeDashboardPort(port);
  await shell.openExternal(`http://127.0.0.1:${openPort}`);
  return { ok: true };
});

ipcMain.handle('runtime:clear-logs', async () => {
  logBuffer.length = 0;
  return { ok: true };
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
    appendLog('dashboard', 'system', `Installing plugin "${normalized}"...`);
    await installPluginDependency(normalized);
    const plugins = await listInstalledPlugins();
    appendLog('dashboard', 'system', `Installed plugin "${normalized}".`);
    return { ok: true, package: normalized, plugins, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const legacyPackageName = resolveLegacyPluginPackage(normalized);

    if (legacyPackageName) {
      try {
        const aliasSpec = toNpmAliasInstallSpec(normalized, legacyPackageName);
        appendLog('dashboard', 'system', `Registry install failed; retrying via legacy alias: ${aliasSpec}`);
        await installPluginDependency(aliasSpec);
        const plugins = await listInstalledPlugins();
        appendLog('dashboard', 'system', `Installed plugin "${normalized}" using legacy package alias "${legacyPackageName}".`);
        return { ok: true, package: normalized, plugins, error: null };
      } catch (legacyErr) {
        const legacyMessage = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        appendLog('dashboard', 'system', `Legacy alias install failed for "${normalized}": ${legacyMessage}`);
      }
    }

    const localSource = await resolveLocalPluginSource(normalized);

    if (localSource) {
      try {
        appendLog('dashboard', 'system', `Registry install failed; retrying from local source: ${localSource}`);
        await installPluginDependency(toFileInstallSpec(normalized, localSource));
        const plugins = await listInstalledPlugins();
        appendLog('dashboard', 'system', `Installed plugin "${normalized}" from local source.`);
        return { ok: true, package: normalized, plugins, error: null };
      } catch (localErr) {
        const localMessage = localErr instanceof Error ? localErr.message : String(localErr);
        appendLog('dashboard', 'system', `Local plugin install failed for "${normalized}": ${localMessage}`);
        return {
          ok: false,
          package: normalized,
          plugins: await listInstalledPlugins(),
          error: `Registry install failed: ${message}\nLocal fallback failed: ${localMessage}`,
        };
      }
    }

    appendLog('dashboard', 'system', `Plugin install failed for "${normalized}": ${message}`);
    return {
      ok: false,
      package: normalized,
      plugins: await listInstalledPlugins(),
      error: message,
    };
  }
});

ipcMain.handle('runtime:get-network', async (_event, port?: number) => {
  const requestedPort = toSafeDashboardPort(port);
  await ensureDashboardRuntime(requestedPort);
  const activePort = dashboardRuntime.running ? dashboardRuntime.port : requestedPort;
  return fetchNetworkSnapshot(activePort);
});

ipcMain.handle(
  'runtime:get-dashboard-data',
  async (
    _event,
    endpoint: string,
    options?: { port?: number; query?: Record<string, unknown> },
  ) => {
    const safeEndpoint = toSafeDashboardEndpoint(endpoint);
    if (!safeEndpoint) {
      return {
        ok: false,
        data: null,
        error: `Unsupported dashboard endpoint: ${endpoint}`,
        status: null,
      } satisfies DashboardApiResult;
    }

    const requestedPort = toSafeDashboardPort(options?.port);
    await ensureDashboardRuntime(requestedPort);

    const safeQuery = sanitizeDashboardQuery(options?.query);
    const activePort = dashboardRuntime.running ? dashboardRuntime.port : requestedPort;
    return fetchDashboardData(safeEndpoint, activePort, safeQuery);
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

ipcMain.handle('wallet:get-info', async (_event, port?: number): Promise<{ ok: boolean; data: WalletInfo | null; error: string | null }> => {
  try {
    const requestedPort = toSafeDashboardPort(port);
    await ensureDashboardRuntime(requestedPort);
    const activePort = dashboardRuntime.running ? dashboardRuntime.port : requestedPort;

    const [statusResult, configResult] = await Promise.all([
      fetchDashboardData('status', activePort),
      fetchDashboardData('config', activePort),
    ]);

    const statusData = statusResult.ok ? asRecord(statusResult.data) : {};
    const configData = configResult.ok ? asRecord(asRecord(configResult.data).config ?? configResult.data) : {};
    const identity = asRecord(configData.identity);
    const payments = asRecord(configData.payments);

    const walletAddress = asString(statusData.walletAddress as string, '') || asString(identity.walletAddress as string, '');

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
  appendLog('dashboard', 'system', `Deposit requested: ${amount} USDC. Run 'antseed deposit ${amount}' in terminal.`);
  return { ok: true, message: `Deposit of ${amount} USDC logged. Use CLI to execute: antseed deposit ${amount}` };
});

ipcMain.handle('wallet:withdraw', async (_event, amount: string) => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { ok: false, error: 'Invalid withdrawal amount' };
  }
  appendLog('dashboard', 'system', `Withdrawal requested: ${amount} USDC. Run 'antseed withdraw ${amount}' in terminal.`);
  return { ok: true, message: `Withdrawal of ${amount} USDC logged. Use CLI to execute: antseed withdraw ${amount}` };
});

// ── WalletConnect IPC Handlers ──

const walletConnectManager = new WalletConnectManager();

walletConnectManager.on('state', (state: unknown) => {
  mainWindow?.webContents.send('wallet:wc-state-changed', state);
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
const chatEngine = (process.env['ANTSEED_CHAT_ENGINE'] ?? 'pi').trim().toLowerCase();

if (chatEngine === 'pi') {
  registerPiChatHandlers({
    ipcMain,
    sendToRenderer: (channel, payload) => {
      mainWindow?.webContents.send(channel, payload);
    },
    configPath: ACTIVE_CONFIG_PATH,
    isBuyerRuntimeRunning: () => getCombinedProcessState().some((state) => state.mode === 'connect' && state.running),
    appendSystemLog: (line) => {
      appendLog('dashboard', 'system', line);
    },
    getNetworkPeers: async () => {
      const requestedPort = dashboardRuntime.port;
      await ensureDashboardRuntime(requestedPort);
      const activePort = dashboardRuntime.running ? dashboardRuntime.port : requestedPort;
      const snapshot = await fetchNetworkSnapshot(activePort);
      if (!snapshot.ok) {
        return [];
      }
      return snapshot.peers
        .map((peer) => ({
          host: typeof peer.host === 'string' ? peer.host.trim() : '',
          port: Number(peer.port) || 0,
          providers: Array.isArray(peer.providers) ? peer.providers.map((provider) => String(provider)) : [],
        }))
        .filter((peer) => peer.host.length > 0 && peer.port > 0 && peer.port <= 65535);
    },
  });
} else {

type TextBlock = { type: 'text'; text: string };
type ThinkingBlock = { type: 'thinking'; thinking: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

type AiMessageMeta = {
  peerId?: string;
  peerAddress?: string;
  peerProviders?: string[];
  peerReputation?: number;
  peerTrustScore?: number;
  peerCurrentLoad?: number;
  peerMaxConcurrency?: number;
  provider?: string;
  model?: string;
  requestId?: string;
  routeRequestId?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokenSource?: 'usage' | 'estimated' | 'unknown';
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  estimatedCostUsd?: number;
};

type AiChatMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  createdAt?: number;
  meta?: AiMessageMeta;
};

type AiUsageTotals = {
  inputTokens: number;
  outputTokens: number;
};

type AiConversation = {
  id: string;
  title: string;
  model: string;
  messages: AiChatMessage[];
  createdAt: number;
  updatedAt: number;
  usage: AiUsageTotals;
};

type AiConversationSummary = {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  usage: AiUsageTotals;
  totalTokens: number;
  totalEstimatedCostUsd: number;
};

const ANTSEED_HOME_DIR = path.join(homedir(), '.antseed');
const CHAT_DATA_DIR = path.join(ANTSEED_HOME_DIR, 'chat');
const CHAT_HISTORY_DIR = path.join(CHAT_DATA_DIR, 'history');
const CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'projects');
const LEGACY_DESKTOP_APP_DIR = path.resolve(__dirname, '../..');
const LEGACY_CHAT_DATA_DIR = path.join(LEGACY_DESKTOP_APP_DIR, '.antseed-chat');
const LEGACY_CHAT_HISTORY_DIR = path.join(LEGACY_CHAT_DATA_DIR, 'history');
const LEGACY_CHAT_WORKSPACE_DIR = path.join(LEGACY_CHAT_DATA_DIR, 'workspace');
const LEGACY_HOME_CHAT_HISTORY_DIR = path.join(ANTSEED_HOME_DIR, 'chat-history');
const LEGACY_HOME_CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'workspace');

function normalizeTokenCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function usageFromUnknown(value: unknown): AiUsageTotals {
  const usage = asRecord(value);
  const total = normalizeTokenCount(
    usage.totalTokens
    ?? usage.total_tokens
    ?? usage.total_token_count,
  );
  let input = normalizeTokenCount(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count,
  );
  let output = normalizeTokenCount(
    usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.completion_tokens
    ?? usage.output_token_count
    ?? usage.completion_token_count,
  );

  if (total > 0) {
    if (input === 0 && output === 0) {
      output = total;
    } else if (output === 0 && input > 0 && total >= input) {
      output = total - input;
    } else if (input === 0 && output > 0 && total >= output) {
      input = total - output;
    }
  }

  return {
    inputTokens: input,
    outputTokens: output,
  };
}

function mergeUsage(base: AiUsageTotals | undefined, delta: Partial<AiUsageTotals> | undefined): AiUsageTotals {
  const baseInput = normalizeTokenCount(base?.inputTokens);
  const baseOutput = normalizeTokenCount(base?.outputTokens);
  const deltaInput = normalizeTokenCount(delta?.inputTokens);
  const deltaOutput = normalizeTokenCount(delta?.outputTokens);
  return {
    inputTokens: baseInput + deltaInput,
    outputTokens: baseOutput + deltaOutput,
  };
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return undefined;
}

function parseTokenSource(value: unknown): AiMessageMeta['tokenSource'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'usage' || normalized === 'estimated') {
    return normalized;
  }
  return 'unknown';
}

function parseHeaderNumber(headers: Headers, key: string): number | undefined {
  const value = headers.get(key);
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseHeaderCsv(headers: Headers, key: string): string[] | undefined {
  const raw = headers.get(key);
  if (raw === null || raw.trim().length === 0) {
    return undefined;
  }
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseResponseMeta(response: Response, requestStartedAt: number): AiMessageMeta {
  const peerIdRaw = response.headers.get('x-antseed-peer-id');
  const peerAddressRaw = response.headers.get('x-antseed-peer-address');
  const peerProvidersRaw = parseHeaderCsv(response.headers, 'x-antseed-peer-providers');
  const providerRaw = response.headers.get('x-antseed-provider');
  const modelRaw = response.headers.get('x-antseed-model');
  const requestIdRaw = response.headers.get('request-id') ?? response.headers.get('x-request-id');
  const routeRequestIdRaw = response.headers.get('x-antseed-request-id');

  const inputTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-input-tokens'));
  const outputTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-output-tokens'));
  const headerTotalTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-total-tokens'));
  const totalTokens = headerTotalTokens > 0 ? headerTotalTokens : inputTokens + outputTokens;

  const inputUsdPerMillion = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-input-usd-per-million'));
  const outputUsdPerMillion = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-output-usd-per-million'));
  const estimatedCostUsd = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-estimated-cost-usd'));
  const peerReputation = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-reputation'));
  const peerTrustScore = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-trust-score'));
  const peerCurrentLoad = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-current-load'));
  const peerMaxConcurrency = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-max-concurrency'));
  const latencyFromHeader = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-latency-ms'));

  const latencyMs = latencyFromHeader !== undefined
    ? Math.max(0, Math.floor(latencyFromHeader))
    : Math.max(0, Date.now() - requestStartedAt);

  return {
    peerId: typeof peerIdRaw === 'string' && peerIdRaw.trim().length > 0 ? peerIdRaw.trim() : undefined,
    peerAddress: typeof peerAddressRaw === 'string' && peerAddressRaw.trim().length > 0 ? peerAddressRaw.trim() : undefined,
    peerProviders: peerProvidersRaw,
    peerReputation,
    peerTrustScore,
    peerCurrentLoad,
    peerMaxConcurrency,
    provider: typeof providerRaw === 'string' && providerRaw.trim().length > 0 ? providerRaw.trim() : undefined,
    model: typeof modelRaw === 'string' && modelRaw.trim().length > 0 ? modelRaw.trim() : undefined,
    requestId: typeof requestIdRaw === 'string' && requestIdRaw.trim().length > 0 ? requestIdRaw.trim() : undefined,
    routeRequestId: typeof routeRequestIdRaw === 'string' && routeRequestIdRaw.trim().length > 0 ? routeRequestIdRaw.trim() : undefined,
    latencyMs,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenSource: parseTokenSource(response.headers.get('x-antseed-token-source')),
    inputUsdPerMillion,
    outputUsdPerMillion,
    estimatedCostUsd,
  };
}

function usageFromMeta(meta: AiMessageMeta | undefined): AiUsageTotals {
  if (!meta) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const input = normalizeTokenCount(meta.inputTokens);
  const output = normalizeTokenCount(meta.outputTokens);
  const total = normalizeTokenCount(meta.totalTokens);

  let resolvedInput = input;
  let resolvedOutput = output;
  if (total > 0) {
    if (resolvedInput === 0 && resolvedOutput === 0) {
      resolvedOutput = total;
    } else if (resolvedOutput === 0 && total >= resolvedInput) {
      resolvedOutput = total - resolvedInput;
    } else if (resolvedInput === 0 && total >= resolvedOutput) {
      resolvedInput = total - resolvedOutput;
    }
  }

  return { inputTokens: resolvedInput, outputTokens: resolvedOutput };
}

function resolveTurnUsage(primary: AiUsageTotals, fallbackMeta?: AiMessageMeta): AiUsageTotals {
  const fallback = usageFromMeta(fallbackMeta);
  return {
    inputTokens: Math.max(normalizeTokenCount(primary.inputTokens), normalizeTokenCount(fallback.inputTokens)),
    outputTokens: Math.max(normalizeTokenCount(primary.outputTokens), normalizeTokenCount(fallback.outputTokens)),
  };
}

function estimateTokensFromText(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return 0;
  }
  return Math.max(1, Math.round(normalized.length / 4));
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'thinking') return block.thinking;
      if (block.type === 'tool_result') return block.content;
      if (block.type === 'tool_use') return JSON.stringify(block.input ?? {});
      return '';
    })
    .join('\n');
}

function estimateUsageFromBytes(inputBytes: number, outputBytes: number): AiUsageTotals {
  if (inputBytes <= 0 && outputBytes <= 0) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: Math.max(1, Math.round(Math.max(0, inputBytes) / 4)),
    outputTokens: Math.max(1, Math.round(Math.max(0, outputBytes) / 4)),
  };
}

function resolveTurnUsageWithEstimate(
  primary: AiUsageTotals,
  fallbackMeta: AiMessageMeta | undefined,
  requestBytes: number,
  responseBytes: number,
): { usage: AiUsageTotals; tokenSource: 'usage' | 'estimated' } {
  const resolved = resolveTurnUsage(primary, fallbackMeta);
  const total = normalizeTokenCount(resolved.inputTokens) + normalizeTokenCount(resolved.outputTokens);
  if (total > 0) {
    const source = fallbackMeta?.tokenSource === 'estimated' ? 'estimated' : 'usage';
    return { usage: resolved, tokenSource: source };
  }
  return {
    usage: estimateUsageFromBytes(requestBytes, responseBytes),
    tokenSource: 'estimated',
  };
}

function deriveMessageUsage(messages: AiChatMessage[], assistantIndex: number): AiUsageTotals {
  const message = messages[assistantIndex];
  if (!message || message.role !== 'assistant') {
    return { inputTokens: 0, outputTokens: 0 };
  }

  const fromMeta = usageFromMeta(message.meta);
  if (fromMeta.inputTokens > 0 || fromMeta.outputTokens > 0) {
    return fromMeta;
  }

  const outputTokens = estimateTokensFromText(contentToText(message.content));
  if (outputTokens <= 0) {
    return { inputTokens: 0, outputTokens: 0 };
  }

  let inputTokens = 0;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || candidate.role !== 'user') continue;
    inputTokens = estimateTokensFromText(contentToText(candidate.content));
    if (inputTokens > 0) break;
  }
  if (inputTokens <= 0) {
    inputTokens = Math.max(1, Math.round(outputTokens * 0.6));
  }

  return { inputTokens, outputTokens };
}

function deriveConversationUsageFromMessages(messages: AiChatMessage[]): AiUsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;

    const usage = deriveMessageUsage(messages, index);
    if (usage.inputTokens <= 0 && usage.outputTokens <= 0) {
      continue;
    }

    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;

    if (!message.meta || normalizeTokenCount(message.meta.totalTokens) <= 0) {
      const totalTokens = usage.inputTokens + usage.outputTokens;
      message.meta = {
        ...(message.meta ?? {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens,
        tokenSource: 'estimated',
      };
    }
  }

  return { inputTokens, outputTokens };
}

function finalizeMessageMeta(baseMeta: AiMessageMeta | undefined, usage: AiUsageTotals): AiMessageMeta | undefined {
  if (!baseMeta) {
    const total = normalizeTokenCount(usage.inputTokens) + normalizeTokenCount(usage.outputTokens);
    if (total <= 0) return undefined;
    return {
      inputTokens: normalizeTokenCount(usage.inputTokens),
      outputTokens: normalizeTokenCount(usage.outputTokens),
      totalTokens: total,
      tokenSource: 'usage',
    };
  }

  const inputTokens = Math.max(normalizeTokenCount(baseMeta.inputTokens), normalizeTokenCount(usage.inputTokens));
  const outputTokens = Math.max(normalizeTokenCount(baseMeta.outputTokens), normalizeTokenCount(usage.outputTokens));
  const totalTokens = normalizeTokenCount(baseMeta.totalTokens) > 0
    ? Math.max(normalizeTokenCount(baseMeta.totalTokens), inputTokens + outputTokens)
    : inputTokens + outputTokens;

  let estimatedCostUsd = normalizeOptionalNumber(baseMeta.estimatedCostUsd);
  if (
    (!estimatedCostUsd || estimatedCostUsd <= 0) &&
    baseMeta.inputUsdPerMillion !== undefined &&
    baseMeta.outputUsdPerMillion !== undefined &&
    Number.isFinite(baseMeta.inputUsdPerMillion) &&
    Number.isFinite(baseMeta.outputUsdPerMillion) &&
    totalTokens > 0
  ) {
    estimatedCostUsd =
      (inputTokens * baseMeta.inputUsdPerMillion + outputTokens * baseMeta.outputUsdPerMillion) / 1_000_000;
  }

  return {
    ...baseMeta,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenSource: baseMeta.tokenSource && baseMeta.tokenSource !== 'unknown'
      ? baseMeta.tokenSource
      : (totalTokens > 0 ? 'usage' : 'unknown'),
    estimatedCostUsd,
  };
}

function normalizeMessageMeta(value: unknown): AiMessageMeta | undefined {
  const meta = asRecord(value);
  if (Object.keys(meta).length === 0) {
    return undefined;
  }

  const normalized: AiMessageMeta = {
    peerId: typeof meta.peerId === 'string' && meta.peerId.trim().length > 0 ? meta.peerId.trim() : undefined,
    peerAddress: typeof meta.peerAddress === 'string' && meta.peerAddress.trim().length > 0 ? meta.peerAddress.trim() : undefined,
    peerProviders: Array.isArray(meta.peerProviders)
      ? (() => {
          const values = meta.peerProviders.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
          return values.length > 0 ? values : undefined;
        })()
      : undefined,
    peerReputation: normalizeOptionalNumber(meta.peerReputation),
    peerTrustScore: normalizeOptionalNumber(meta.peerTrustScore),
    peerCurrentLoad: normalizeOptionalNumber(meta.peerCurrentLoad),
    peerMaxConcurrency: normalizeOptionalNumber(meta.peerMaxConcurrency),
    provider: typeof meta.provider === 'string' && meta.provider.trim().length > 0 ? meta.provider.trim() : undefined,
    model: typeof meta.model === 'string' && meta.model.trim().length > 0 ? meta.model.trim() : undefined,
    requestId: typeof meta.requestId === 'string' && meta.requestId.trim().length > 0 ? meta.requestId.trim() : undefined,
    routeRequestId: typeof meta.routeRequestId === 'string' && meta.routeRequestId.trim().length > 0
      ? meta.routeRequestId.trim()
      : undefined,
    latencyMs: normalizeOptionalNumber(meta.latencyMs),
    inputTokens: normalizeTokenCount(meta.inputTokens),
    outputTokens: normalizeTokenCount(meta.outputTokens),
    totalTokens: normalizeTokenCount(meta.totalTokens),
    tokenSource: parseTokenSource(meta.tokenSource),
    inputUsdPerMillion: normalizeOptionalNumber(meta.inputUsdPerMillion),
    outputUsdPerMillion: normalizeOptionalNumber(meta.outputUsdPerMillion),
    estimatedCostUsd: normalizeOptionalNumber(meta.estimatedCostUsd),
  };

  const hasValue = Object.values(normalized).some((value) => value !== undefined && value !== 'unknown');
  return hasValue ? normalized : undefined;
}

function normalizeChatMessage(value: unknown): AiChatMessage {
  const msg = asRecord(value);
  const role = msg.role === 'assistant' ? 'assistant' : 'user';
  const content = typeof msg.content === 'string' || Array.isArray(msg.content)
    ? (msg.content as string | ContentBlock[])
    : '';
  const createdAt = normalizeTokenCount(msg.createdAt);
  const meta = normalizeMessageMeta(msg.meta ?? msg.metadata);
  return {
    role,
    content,
    createdAt: createdAt > 0 ? createdAt : undefined,
    meta,
  };
}

function normalizeConversation(value: unknown): AiConversation {
  const conv = asRecord(value);
  const now = Date.now();
  const createdAt = normalizeTokenCount(conv.createdAt) || now;
  const updatedAt = normalizeTokenCount(conv.updatedAt) || createdAt;
  const messages = Array.isArray(conv.messages) ? conv.messages.map((msg) => normalizeChatMessage(msg)) : [];
  const persistedUsage = usageFromUnknown(conv.usage);
  const derivedUsage = deriveConversationUsageFromMessages(messages);
  const usage: AiUsageTotals = {
    inputTokens: Math.max(persistedUsage.inputTokens, derivedUsage.inputTokens),
    outputTokens: Math.max(persistedUsage.outputTokens, derivedUsage.outputTokens),
  };
  return {
    id: asString(conv.id, randomUUID()),
    title: asString(conv.title, 'New conversation'),
    model: asString(conv.model, 'claude-sonnet-4-20250514'),
    messages,
    createdAt,
    updatedAt,
    usage,
  };
}

async function ensureChatDataDirs(): Promise<void> {
  await migrateLegacyChatData();
  await mkdir(CHAT_HISTORY_DIR, { recursive: true });
  await mkdir(CHAT_WORKSPACE_DIR, { recursive: true });
}

async function migrateLegacyChatData(): Promise<void> {
  const legacyHistoryDirs = [LEGACY_CHAT_HISTORY_DIR, LEGACY_HOME_CHAT_HISTORY_DIR].filter((dir) => existsSync(dir));
  const legacyWorkspaceDirs = [LEGACY_CHAT_WORKSPACE_DIR, LEGACY_HOME_CHAT_WORKSPACE_DIR].filter((dir) => existsSync(dir));
  if (legacyHistoryDirs.length === 0 && legacyWorkspaceDirs.length === 0) {
    return;
  }

  await mkdir(CHAT_HISTORY_DIR, { recursive: true });
  await mkdir(CHAT_WORKSPACE_DIR, { recursive: true });

  for (const legacyHistoryDir of legacyHistoryDirs) {
    try {
      const files = await readdir(legacyHistoryDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const source = path.join(legacyHistoryDir, file);
        const target = path.join(CHAT_HISTORY_DIR, file);
        if (existsSync(target)) continue;
        await cp(source, target, { force: false });
      }
    } catch {
      // Best-effort migration only.
    }
  }

  for (const legacyWorkspaceDir of legacyWorkspaceDirs) {
    try {
      const existing = await readdir(CHAT_WORKSPACE_DIR);
      if (existing.length > 0) break;
      await cp(legacyWorkspaceDir, CHAT_WORKSPACE_DIR, {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
      break;
    } catch {
      // Best-effort migration only.
    }
  }
}

function resolveWorkspacePath(inputPath: string): string {
  const raw = inputPath.trim();
  const candidate = raw.length > 0 ? raw : '.';
  const workspaceRoot = path.resolve(CHAT_WORKSPACE_DIR);
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspaceRoot, candidate);

  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Path escapes chat workspace: ${candidate}`);
  }
  return absolute;
}

class ChatStorage {
  private _dir: string;
  private _ready: Promise<void>;

  constructor(dir: string) {
    this._dir = dir;
    this._ready = ensureChatDataDirs().then(() => mkdir(dir, { recursive: true })).then(() => {});
  }

  private _path(id: string): string {
    return path.join(this._dir, `${id}.json`);
  }

  async list(): Promise<AiConversationSummary[]> {
    await this._ready;
    let files: string[];
    try {
      files = await readdir(this._dir);
    } catch {
      return [];
    }
    const summaries: AiConversationSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(this._dir, file), 'utf-8');
        const conv = normalizeConversation(JSON.parse(raw));
        const totalTokensFromUsage = conv.usage.inputTokens + conv.usage.outputTokens;
        const totalTokensFromMessages = conv.messages.reduce((sum, msg) => {
          if (msg.role !== 'assistant') return sum;
          const fromMeta = usageFromMeta(msg.meta);
          return sum + fromMeta.inputTokens + fromMeta.outputTokens;
        }, 0);
        const totalTokens = Math.max(totalTokensFromUsage, totalTokensFromMessages);
        const totalEstimatedCostUsd = conv.messages.reduce((sum, msg) => {
          const cost = Number(msg.meta?.estimatedCostUsd);
          if (!Number.isFinite(cost) || cost <= 0) {
            return sum;
          }
          return sum + cost;
        }, 0);
        summaries.push({
          id: conv.id,
          title: conv.title,
          model: conv.model,
          messageCount: conv.messages.length,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          usage: conv.usage,
          totalTokens,
          totalEstimatedCostUsd,
        });
      } catch {
        // Skip corrupt files
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<AiConversation | null> {
    await this._ready;
    try {
      const raw = await readFile(this._path(id), 'utf-8');
      return normalizeConversation(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(conv: AiConversation): Promise<void> {
    await this._ready;
    const normalized = normalizeConversation(conv);
    await writeFile(this._path(normalized.id), JSON.stringify(normalized, null, 2), 'utf-8');
  }

  async delete(id: string): Promise<void> {
    await this._ready;
    try {
      await unlink(this._path(id));
    } catch {
      // Already gone
    }
  }
}

const chatStorage = new ChatStorage(CHAT_HISTORY_DIR);
let chatAbortController: AbortController | null = null;

const toolDefinitions = [
  {
    name: 'bash',
    description: 'Execute a shell command. Use for running scripts, installing packages, git operations, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to file inside chat workspace (absolute or relative)' },
        limit: { type: 'number', description: 'Max lines to read (default: all)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to file inside chat workspace (absolute or relative)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at the given path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path inside chat workspace (default: .)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for files matching a name pattern.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'File name pattern (e.g. "*.ts")' },
        path: { type: 'string', description: 'Base directory inside chat workspace (default: .)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents using a regex pattern.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory inside chat workspace (default: .)' },
        include: { type: 'string', description: 'File glob to include (e.g. "*.ts")' },
      },
      required: ['pattern'],
    },
  },
];

async function executeTool(name: string, input: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
  try {
    await ensureChatDataDirs();

    switch (name) {
      case 'bash': {
        const command = String(input.command ?? '');
        if (!command) return { output: 'No command provided', isError: true };
        const timeout = Math.min(Math.max(Number(input.timeout) || 120000, 1000), 120000);
        const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', command], {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          cwd: CHAT_WORKSPACE_DIR,
          env: {
            ...process.env,
            HOME: CHAT_WORKSPACE_DIR,
            PWD: CHAT_WORKSPACE_DIR,
          },
        });
        let result = stdout || '';
        if (stderr) result += (result ? '\n' : '') + stderr;
        if (result.length > 30000) result = result.slice(0, 30000) + '\n... (truncated)';
        return { output: result || '(no output)', isError: false };
      }
      case 'read_file': {
        const filePath = String(input.path ?? '');
        if (!filePath) return { output: 'No path provided', isError: true };
        const resolvedPath = resolveWorkspacePath(filePath);
        let content = await readFile(resolvedPath, 'utf-8');
        const limit = Number(input.limit);
        if (limit > 0) {
          const lines = content.split('\n');
          content = lines.slice(0, limit).join('\n');
        }
        if (content.length > 30000) content = content.slice(0, 30000) + '\n... (truncated)';
        return { output: content, isError: false };
      }
      case 'write_file': {
        const filePath = String(input.path ?? '');
        const content = String(input.content ?? '');
        if (!filePath) return { output: 'No path provided', isError: true };
        const resolvedPath = resolveWorkspacePath(filePath);
        await mkdir(path.dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, content, 'utf-8');
        return { output: `Wrote ${content.length} characters to ${resolvedPath}`, isError: false };
      }
      case 'list_directory': {
        const dirPath = resolveWorkspacePath(String(input.path ?? '.'));
        const entries = await readdir(dirPath, { withFileTypes: true });
        const lines = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
        return { output: lines.join('\n') || '(empty directory)', isError: false };
      }
      case 'search_files': {
        const pattern = String(input.pattern ?? '');
        const basePath = resolveWorkspacePath(String(input.path ?? '.'));
        if (!pattern) return { output: 'No pattern provided', isError: true };
        const { stdout } = await execFileAsync('/usr/bin/find', [basePath, '-name', pattern, '-type', 'f'], {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });
        const result = stdout.trim();
        if (result.length > 30000) return { output: result.slice(0, 30000) + '\n... (truncated)', isError: false };
        return { output: result || 'No files found', isError: false };
      }
      case 'grep': {
        const pattern = String(input.pattern ?? '');
        const searchPath = resolveWorkspacePath(String(input.path ?? '.'));
        if (!pattern) return { output: 'No pattern provided', isError: true };
        const args = ['-rn', pattern, searchPath];
        if (input.include) args.push('--include', String(input.include));
        try {
          const { stdout } = await execFileAsync('/usr/bin/grep', args, {
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          });
          let result = stdout.trim();
          if (result.length > 30000) result = result.slice(0, 30000) + '\n... (truncated)';
          return { output: result || 'No matches found', isError: false };
        } catch (grepErr) {
          if ((grepErr as { code?: number }).code === 1) {
            return { output: 'No matches found', isError: false };
          }
          throw grepErr;
        }
      }
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function getProxyPort(): number {
  return 8377;
}

function isProxyRunning(): boolean {
  return isModeRunning('connect', getCombinedProcessState());
}

async function resolveProxyPort(): Promise<number> {
  try {
    const config = await loadDashboardConfig(ACTIVE_CONFIG_PATH);
    const configured = Number(config.buyer?.proxyPort);
    if (Number.isFinite(configured) && configured > 0 && configured <= 65535) {
      return Math.floor(configured);
    }
  } catch {
    // fall back
  }
  return getProxyPort();
}

async function isPortReachable(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Math.floor(port) });

    let settled = false;
    const finalize = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.once('connect', () => finalize(true));
    socket.once('error', () => finalize(false));
    socket.setTimeout(timeoutMs, () => finalize(false));
  });
}

async function isProxyAvailable(port: number): Promise<boolean> {
  if (isProxyRunning()) {
    return true;
  }
  return isPortReachable(port);
}

function isModeRunning(mode: string, processes: RuntimeProcessState[]): boolean {
  const proc = processes.find((p) => p.mode === mode);
  return Boolean(proc && proc.running);
}

ipcMain.handle('chat:ai-get-proxy-status', async () => {
  const port = await resolveProxyPort();
  const running = await isProxyAvailable(port);
  return {
    ok: true,
    data: {
      running,
      port,
    },
  };
});

ipcMain.handle('chat:ai-list-conversations', async () => {
  const conversations = await chatStorage.list();
  return { ok: true, data: conversations };
});

ipcMain.handle('chat:ai-get-conversation', async (_event, id: string) => {
  const conv = await chatStorage.get(id);
  if (!conv) {
    return { ok: false, error: 'Conversation not found' };
  }
  return { ok: true, data: conv };
});

ipcMain.handle('chat:ai-create-conversation', async (_event, model: string) => {
  const conv: AiConversation = {
    id: randomUUID(),
    title: 'New conversation',
    model: model || 'claude-sonnet-4-20250514',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  await chatStorage.save(conv);
  return { ok: true, data: conv };
});

ipcMain.handle('chat:ai-delete-conversation', async (_event, id: string) => {
  await chatStorage.delete(id);
  return { ok: true };
});

ipcMain.handle('chat:ai-send', async (_event, conversationId: string, userMessage: string, model?: string) => {
  if (!userMessage || userMessage.trim().length === 0) {
    return { ok: false, error: 'Empty message' };
  }

  const proxyPort = await resolveProxyPort();
  if (!(await isProxyAvailable(proxyPort))) {
    return { ok: false, error: `Buyer proxy is not reachable on port ${proxyPort}. Start Buyer runtime or fix buyer.proxyPort in config.` };
  }

  const conv = await chatStorage.get(conversationId);
  if (!conv) {
    return { ok: false, error: 'Conversation not found' };
  }

  // Add user message
  conv.messages.push({ role: 'user', content: userMessage.trim(), createdAt: Date.now() });
  conv.updatedAt = Date.now();

  // Auto-title from first user message
  if (conv.title === 'New conversation' && conv.messages.filter(m => m.role === 'user').length === 1) {
    conv.title = userMessage.trim().slice(0, 60) + (userMessage.trim().length > 60 ? '...' : '');
  }

  if (model) {
    conv.model = model;
  }

  await chatStorage.save(conv);

  // Notify renderer that user message is persisted
  mainWindow?.webContents.send('chat:ai-user-persisted', { conversationId, message: conv.messages[conv.messages.length - 1] });

  const url = `http://127.0.0.1:${proxyPort}/v1/messages`;

  const requestBody = {
    model: conv.model,
    max_tokens: 4096,
    messages: conv.messages.map(m => ({ role: m.role, content: m.content })),
  };
  const requestBodyJson = JSON.stringify(requestBody);

  chatAbortController = new AbortController();

  try {
    const requestStartedAt = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: requestBodyJson,
      signal: chatAbortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = `Proxy returned ${response.status}: ${errorText.slice(0, 200)}`;
      mainWindow?.webContents.send('chat:ai-error', { conversationId, error });
      return { ok: false, error };
    }

    const responseMeta = parseResponseMeta(response, requestStartedAt);
    const result = await response.json() as { content?: Array<{ type: string; text?: string }>; usage?: Record<string, unknown> };
    const assistantText = result.content
      ?.filter((block: { type: string }) => block.type === 'text')
      .map((block: { text?: string }) => block.text ?? '')
      .join('') ?? '';

    const usageResolution = resolveTurnUsageWithEstimate(
      usageFromUnknown(result.usage),
      responseMeta,
      Buffer.byteLength(requestBodyJson, 'utf8'),
      Buffer.byteLength(assistantText, 'utf8'),
    );
    conv.usage = mergeUsage(conv.usage, usageResolution.usage);
    const messageMeta = finalizeMessageMeta(
      {
        ...responseMeta,
        tokenSource: usageResolution.tokenSource,
      },
      usageResolution.usage,
    );

    if (assistantText.length > 0) {
      const assistantMessage: AiChatMessage = {
        role: 'assistant',
        content: assistantText,
        createdAt: Date.now(),
        meta: messageMeta,
      };
      conv.messages.push(assistantMessage);
      conv.updatedAt = Date.now();
      await chatStorage.save(conv);

      mainWindow?.webContents.send('chat:ai-done', {
        conversationId,
        message: assistantMessage,
      });
    }

    return { ok: true };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      mainWindow?.webContents.send('chat:ai-error', { conversationId, error: 'Request aborted' });
      return { ok: false, error: 'Aborted' };
    }
    const error = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send('chat:ai-error', { conversationId, error });
    return { ok: false, error };
  } finally {
    chatAbortController = null;
  }
});

ipcMain.handle('chat:ai-abort', async () => {
  if (chatAbortController) {
    chatAbortController.abort();
    chatAbortController = null;
  }
  return { ok: true };
});

// ── Streaming AI Chat ──

function escapeJsonControlCharactersInStrings(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!char) continue;

    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }

    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      out += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 0x20) {
      if (char === '\n') out += '\\n';
      else if (char === '\r') out += '\\r';
      else if (char === '\t') out += '\\t';
      else if (char === '\b') out += '\\b';
      else if (char === '\f') out += '\\f';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += char;
  }

  return out;
}

function parseToolInputJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const parseObject = (value: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  return parseObject(trimmed) ?? parseObject(escapeJsonControlCharactersInStrings(trimmed)) ?? {};
}

async function streamSingleTurn(
  conv: AiConversation,
  conversationId: string,
  signal: AbortSignal,
): Promise<{ blocks: ContentBlock[]; usage: AiUsageTotals; meta?: AiMessageMeta }> {
  const proxyPort = await resolveProxyPort();
  const url = `http://127.0.0.1:${proxyPort}/v1/messages`;

  const requestBody = {
    model: conv.model,
    max_tokens: 4096,
    stream: true,
    tools: toolDefinitions,
    messages: conv.messages.map(m => ({ role: m.role, content: m.content })),
  };
  const requestBodyJson = JSON.stringify(requestBody);

  const requestStartedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: requestBodyJson,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Proxy returned ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const responseMeta = parseResponseMeta(response, requestStartedAt);
  const contentType = response.headers.get('content-type') ?? '';

  // Fallback: non-streaming response
  if (!contentType.includes('text/event-stream')) {
    const result = await response.json() as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      usage?: Record<string, unknown>;
    };
    const blocks: ContentBlock[] = [];
    for (const block of result.content ?? []) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text ?? '' });
        mainWindow?.webContents.send('chat:ai-stream-delta', { conversationId, index: 0, blockType: 'text', text: block.text ?? '' });
      } else if (block.type === 'tool_use') {
        blocks.push({ type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} });
      }
    }
    const usageResolution = resolveTurnUsageWithEstimate(
      usageFromUnknown(result.usage),
      responseMeta,
      Buffer.byteLength(requestBodyJson, 'utf8'),
      Buffer.byteLength(contentToText(blocks), 'utf8'),
    );
    return {
      blocks,
      usage: usageResolution.usage,
      meta: finalizeMessageMeta(
        {
          ...responseMeta,
          tokenSource: usageResolution.tokenSource,
        },
        usageResolution.usage,
      ),
    };
  }

  // Parse SSE stream
  const blocks: ContentBlock[] = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let sseBuffer = '';
  let currentBlockIndex = -1;
  let currentBlockType = '';
  let textAccum = '';
  let toolJsonAccum = '';
  let currentToolId = '';
  let currentToolName = '';
  let usage: AiUsageTotals = { inputTokens: 0, outputTokens: 0 };

  const applyUsage = (value: unknown): void => {
    const parsed = usageFromUnknown(value);
    usage = {
      inputTokens: Math.max(usage.inputTokens, parsed.inputTokens),
      outputTokens: Math.max(usage.outputTokens, parsed.outputTokens),
    };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]' || data.length === 0) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      const eventType = String(event.type ?? '');

      switch (eventType) {
        case 'message_start': {
          const message = asRecord(event.message);
          applyUsage(message.usage);
          break;
        }

        case 'content_block_start': {
          const contentBlock = event.content_block as Record<string, unknown> | undefined;
          const index = Number(event.index ?? 0);
          currentBlockIndex = index;
          const blockType = String(contentBlock?.type ?? 'text');
          currentBlockType = blockType;

          if (blockType === 'text') {
            textAccum = String(contentBlock?.text ?? '');
            mainWindow?.webContents.send('chat:ai-stream-block-start', { conversationId, index, blockType: 'text' });
          } else if (blockType === 'tool_use') {
            currentToolId = String(contentBlock?.id ?? '');
            currentToolName = String(contentBlock?.name ?? '');
            toolJsonAccum = '';
            mainWindow?.webContents.send('chat:ai-stream-block-start', { conversationId, index, blockType: 'tool_use', toolId: currentToolId, toolName: currentToolName });
          } else if (blockType === 'thinking') {
            textAccum = '';
            mainWindow?.webContents.send('chat:ai-stream-block-start', { conversationId, index, blockType: 'thinking' });
          }
          break;
        }

        case 'content_block_delta': {
          const delta = event.delta as Record<string, unknown> | undefined;
          const deltaType = String(delta?.type ?? '');

          if (deltaType === 'text_delta') {
            const text = String(delta?.text ?? '');
            textAccum += text;
            mainWindow?.webContents.send('chat:ai-stream-delta', { conversationId, index: currentBlockIndex, blockType: 'text', text });
          } else if (deltaType === 'input_json_delta') {
            const partial = String(delta?.partial_json ?? '');
            toolJsonAccum += partial;
          } else if (deltaType === 'thinking_delta') {
            const thinking = String(delta?.thinking ?? '');
            textAccum += thinking;
            mainWindow?.webContents.send('chat:ai-stream-delta', { conversationId, index: currentBlockIndex, blockType: 'thinking', text: thinking });
          }
          break;
        }

        case 'content_block_stop': {
          if (currentBlockType === 'text') {
            blocks.push({ type: 'text', text: textAccum });
            mainWindow?.webContents.send('chat:ai-stream-block-stop', { conversationId, index: currentBlockIndex, blockType: 'text' });
          } else if (currentBlockType === 'tool_use') {
            const parsedInput = parseToolInputJson(toolJsonAccum);
            blocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: parsedInput });
            mainWindow?.webContents.send('chat:ai-stream-block-stop', { conversationId, index: currentBlockIndex, blockType: 'tool_use', toolId: currentToolId, toolName: currentToolName, input: parsedInput });
          } else if (currentBlockType === 'thinking') {
            blocks.push({ type: 'thinking', thinking: textAccum });
            mainWindow?.webContents.send('chat:ai-stream-block-stop', { conversationId, index: currentBlockIndex, blockType: 'thinking' });
          }
          textAccum = '';
          toolJsonAccum = '';
          break;
        }

        case 'message_stop':
        case 'message_delta': {
          applyUsage(event.usage);
          const message = asRecord(event.message);
          applyUsage(message.usage);
          break;
        }
      }
    }
  }

  const usageResolution = resolveTurnUsageWithEstimate(
    usage,
    responseMeta,
    Buffer.byteLength(requestBodyJson, 'utf8'),
    Buffer.byteLength(contentToText(blocks), 'utf8'),
  );
  return {
    blocks,
    usage: usageResolution.usage,
    meta: finalizeMessageMeta(
      {
        ...responseMeta,
        tokenSource: usageResolution.tokenSource,
      },
      usageResolution.usage,
    ),
  };
}

async function streamingChatLoop(conv: AiConversation, conversationId: string, signal: AbortSignal): Promise<void> {
  const MAX_TURNS = 20;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    mainWindow?.webContents.send('chat:ai-stream-start', { conversationId, turn });

    const streamResult = await streamSingleTurn(conv, conversationId, signal);
    const blocks = streamResult.blocks;
    conv.usage = mergeUsage(conv.usage, streamResult.usage);

    const toolUseBlocks = blocks.filter(b => b.type === 'tool_use') as ToolUseBlock[];

    if (toolUseBlocks.length === 0) {
      // Text-only response — save and finish
      conv.messages.push({
        role: 'assistant',
        content: blocks,
        createdAt: Date.now(),
        meta: streamResult.meta,
      });
      conv.updatedAt = Date.now();
      await chatStorage.save(conv);
      mainWindow?.webContents.send('chat:ai-stream-done', { conversationId });
      return;
    }

    // Save assistant message with tool use blocks
    conv.messages.push({
      role: 'assistant',
      content: blocks,
      createdAt: Date.now(),
      meta: streamResult.meta,
    });
    conv.updatedAt = Date.now();
    await chatStorage.save(conv);

    // Execute tools and build tool_result blocks
    const toolResults: ToolResultBlock[] = [];
    for (const toolBlock of toolUseBlocks) {
      mainWindow?.webContents.send('chat:ai-tool-executing', {
        conversationId,
        toolUseId: toolBlock.id,
        name: toolBlock.name,
        input: toolBlock.input,
      });

      const result = await executeTool(toolBlock.name, toolBlock.input);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: result.output,
        is_error: result.isError,
      });

      mainWindow?.webContents.send('chat:ai-tool-result', {
        conversationId,
        toolUseId: toolBlock.id,
        output: result.output,
        isError: result.isError,
      });
    }

    // Add tool results as user message
    conv.messages.push({ role: 'user', content: toolResults, createdAt: Date.now() });
    conv.updatedAt = Date.now();
    await chatStorage.save(conv);
  }

  // Max turns reached
  mainWindow?.webContents.send('chat:ai-stream-done', { conversationId });
}

ipcMain.handle('chat:ai-send-stream', async (_event, conversationId: string, userMessage: string, model?: string) => {
  if (!userMessage || userMessage.trim().length === 0) {
    return { ok: false, error: 'Empty message' };
  }

  const proxyPort = await resolveProxyPort();
  if (!(await isProxyAvailable(proxyPort))) {
    return { ok: false, error: `Buyer proxy is not reachable on port ${proxyPort}. Start Buyer runtime or fix buyer.proxyPort in config.` };
  }

  const conv = await chatStorage.get(conversationId);
  if (!conv) {
    return { ok: false, error: 'Conversation not found' };
  }

  // Add user message
  conv.messages.push({ role: 'user', content: userMessage.trim(), createdAt: Date.now() });
  conv.updatedAt = Date.now();

  // Auto-title from first user message
  if (conv.title === 'New conversation' && conv.messages.filter(m => m.role === 'user').length === 1) {
    conv.title = userMessage.trim().slice(0, 60) + (userMessage.trim().length > 60 ? '...' : '');
  }

  if (model) {
    conv.model = model;
  }

  await chatStorage.save(conv);

  mainWindow?.webContents.send('chat:ai-user-persisted', { conversationId, message: conv.messages[conv.messages.length - 1] });

  chatAbortController = new AbortController();

  try {
    await streamingChatLoop(conv, conversationId, chatAbortController.signal);
    return { ok: true };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      mainWindow?.webContents.send('chat:ai-stream-error', { conversationId, error: 'Request aborted' });
      return { ok: false, error: 'Aborted' };
    }
    const error = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send('chat:ai-stream-error', { conversationId, error });
    return { ok: false, error };
  } finally {
    chatAbortController = null;
  }
});
}

ipcMain.handle('runtime:scan-network', async (_event, port?: number) => {
  const requestedPort = toSafeDashboardPort(port);
  await ensureDashboardRuntime(requestedPort);
  const activePort = dashboardRuntime.running ? dashboardRuntime.port : requestedPort;
  return scanDashboardNetwork(activePort);
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
  createApplicationMenu();

  createWindow();

  void startDashboardRuntime().catch(() => {
    // Failure is already logged to renderer/system log.
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
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void Promise.allSettled([
      stopDashboardRuntime('window close'),
      processManager.stopAll(),
    ]).finally(() => app.quit());
  }
});

app.on('before-quit', (event) => {
  if ((app as unknown as { __antseedStopping?: boolean }).__antseedStopping) {
    return;
  }

  event.preventDefault();
  (app as unknown as { __antseedStopping?: boolean }).__antseedStopping = true;

  void Promise.allSettled([
    stopDashboardRuntime('app shutdown'),
    processManager.stopAll(),
  ]).finally(() => {
    app.quit();
  });
});
