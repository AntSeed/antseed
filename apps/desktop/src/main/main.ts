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
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { readFile, writeFile, readdir, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createDashboardServer, type DashboardConfig, type DashboardServer } from '@antseed/dashboard';
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
  type StartOptions,
} from './process-manager.js';
import { registerPiChatHandlers } from './pi-chat-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFileCallback);

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

type LogEvent = {
  mode: RuntimeMode;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  timestamp: number;
};

type RuntimeActivityTone = 'active' | 'idle' | 'warn' | 'bad';

type RuntimeActivityEvent = {
  mode: RuntimeMode;
  tone: RuntimeActivityTone;
  stage: string;
  message: string;
  holdMs: number;
  timestamp: number;
  requestId?: string;
  peerId?: string;
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
  'local': '@antseed/router-local',
  'router-local': '@antseed/router-local',
  'antseed-router-local': '@antseed/router-local',
};
const SCOPED_TO_LEGACY_PLUGIN_PACKAGE_MAP: Record<string, string> = {
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
let lastRuntimeActivityHash = '';

let appSetupNeeded = false;
let appSetupComplete = false;

// When a specific connect error (e.g. port-in-use) is detected, suppress the
// generic "exited unexpectedly" message for a short window so the specific
// error isn't overwritten by the process-exit log that immediately follows.
let connectSpecificErrorAt = 0;
const CONNECT_EXIT_SUPPRESS_WINDOW_MS = 5_000;

let dashboardServer: DashboardServer | null = null;
const dashboardRuntime: DashboardRuntimeState = {
  running: false,
  port: DEFAULT_DASHBOARD_PORT,
  startedAt: null,
  lastError: null,
  lastExitCode: null,
};
let dashboardStartPromise: Promise<void> | null = null;
let dashboardPortInUseUntilMs = 0;
const DASHBOARD_PORT_IN_USE_RETRY_COOLDOWN_MS = 60_000;

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

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function shortId(value: string | undefined): string {
  if (!value) {
    return 'unknown';
  }
  return value.length > 8 ? value.slice(0, 8) : value;
}

function toRuntimeActivity(event: Omit<RuntimeActivityEvent, 'timestamp'>): RuntimeActivityEvent {
  return {
    ...event,
    timestamp: Date.now(),
  };
}

function parseConnectRuntimeActivity(lineRaw: string): RuntimeActivityEvent | null {
  const line = stripAnsi(lineRaw).trim();
  if (line.length === 0) {
    return null;
  }

  const proxyBindErrorMatch = /failed to start proxy:\s*listen\s+eaddrinuse:\s*address already in use.*:(\d+)/i.exec(line);
  if (proxyBindErrorMatch) {
    const port = proxyBindErrorMatch[1] ?? '8377';
    connectSpecificErrorAt = Date.now();
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'bad',
      stage: 'proxy-port-in-use',
      message: `Buyer proxy port :${port} is already in use.`,
      holdMs: 120_000,
    });
  }

  if (/process exited \(code=\d+\)/i.test(line)) {
    // If a specific error was just shown (e.g. port in use), don't overwrite it
    // with the generic exit message — the process exiting is a consequence, not the cause.
    if (Date.now() - connectSpecificErrorAt < CONNECT_EXIT_SUPPRESS_WINDOW_MS) {
      return null;
    }
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'bad',
      stage: 'connect-exit',
      message: 'Buyer runtime exited unexpectedly.',
      holdMs: 90_000,
    });
  }

  const adapterMatch = /\[proxy\]\s+Applying protocol adapter\s+([^\s]+)\s*->\s*([^\s]+)\s+via provider\s+"([^"]+)"/i.exec(line);
  if (adapterMatch) {
    const from = adapterMatch[1] ?? 'unknown';
    const to = adapterMatch[2] ?? 'unknown';
    const provider = adapterMatch[3] ?? 'unknown';
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'protocol-adapter',
      message: `Adapting protocol ${from} -> ${to} via ${provider}.`,
      holdMs: 15_000,
    });
  }

  const sendMatch = /\[Node\]\s+sendRequest(?:Stream)?\s+([A-Z]+)\s+(\S+)\s+.*peer\s+([a-f0-9]+)\.\.\.\s+\(reqId=([a-f0-9-]+)\)/i.exec(line);
  if (sendMatch) {
    const method = sendMatch[1] ?? 'REQ';
    const path = sendMatch[2] ?? '/';
    const peerId = sendMatch[3] ?? '';
    const requestId = sendMatch[4] ?? '';
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'request-dispatched',
      message: `Request ${shortId(requestId)}: ${method} ${path} to peer ${shortId(peerId)}...`,
      holdMs: 20_000,
      requestId,
      peerId,
    });
  }

  const routingMatch = /\[proxy\]\s+Routing to peer\s+([a-f0-9]+)\.\.\./i.exec(line);
  if (routingMatch) {
    const peerId = routingMatch[1] ?? '';
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'routing',
      message: `Routing request to peer ${shortId(peerId)}...`,
      holdMs: 15_000,
      peerId,
    });
  }

  const connectingMatch = /\[Node\]\s+Connecting to\s+([a-f0-9]+)\.\.\.\s+at\s+([0-9a-z.:_-]+)/i.exec(line);
  if (connectingMatch) {
    const peerId = connectingMatch[1] ?? '';
    const endpoint = connectingMatch[2] ?? 'unknown';
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'peer-connecting',
      message: `Connecting to peer ${shortId(peerId)} at ${endpoint}...`,
      holdMs: 15_000,
      peerId,
    });
  }

  const connectionStateMatch = /\[Node\]\s+Connection(?: to [a-f0-9.]+)? state:\s*(\w+)/i.exec(line);
  if (connectionStateMatch) {
    const state = (connectionStateMatch[1] ?? '').toLowerCase();
    if (state === 'open') {
      return toRuntimeActivity({
        mode: 'connect',
        tone: 'active',
        stage: 'peer-connected',
        message: 'Peer connection open.',
        holdMs: 12_000,
      });
    }
  }

  const responseMatch = /\[Node\]\s+Response for\s+([a-f0-9-]+):\s+status=(\d+)\s+\((\d+)ms/i.exec(line);
  if (responseMatch) {
    const requestId = responseMatch[1] ?? '';
    const status = Number(responseMatch[2] ?? 0);
    const latencyMs = Number(responseMatch[3] ?? 0);
    const ok = status >= 200 && status < 400;
    return toRuntimeActivity({
      mode: 'connect',
      tone: ok ? 'active' : 'bad',
      stage: 'response',
      message: ok
        ? `Request ${shortId(requestId)} succeeded (${status}, ${String(latencyMs)}ms).`
        : `Request ${shortId(requestId)} failed (${status}, ${String(latencyMs)}ms).`,
      holdMs: ok ? 12_000 : 45_000,
      requestId,
    });
  }

  const timeoutMatch = /\[Node\]\s+Request\s+([a-f0-9-]+)\s+timed out after\s+(\d+)ms/i.exec(line);
  if (timeoutMatch) {
    const requestId = timeoutMatch[1] ?? '';
    const timeoutMs = timeoutMatch[2] ?? '30000';
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'bad',
      stage: 'request-timeout',
      message: `Request ${shortId(requestId)} timed out after ${timeoutMs}ms.`,
      holdMs: 60_000,
      requestId,
    });
  }

  const retryMatch = /\[proxy\]\s+Peer\s+([a-f0-9]+)\.\.\.\s+returned\s+(\d+),\s+retrying.*\(attempt\s+(\d+)\/(\d+)\)/i.exec(line);
  if (retryMatch) {
    const peerId = retryMatch[1] ?? '';
    const code = retryMatch[2] ?? 'unknown';
    const attempt = retryMatch[3] ?? '?';
    const max = retryMatch[4] ?? '?';
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'peer-retry',
      message: `Peer ${shortId(peerId)} returned ${code}. Retrying (${attempt}/${max})...`,
      holdMs: 25_000,
      peerId,
    });
  }

  const allFailedMatch = /\[proxy\]\s+All\s+\d+\s+peer\(s\)\s+failed, returning last error \((\d+)\)/i.exec(line);
  if (allFailedMatch) {
    const code = allFailedMatch[1] ?? 'unknown';
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'bad',
      stage: 'routing-failed',
      message: `All candidate peers failed (${code}).`,
      holdMs: 60_000,
    });
  }

  if (/\[proxy\]\s+No peers available for request/i.test(line)) {
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'bad',
      stage: 'no-peers',
      message: 'No peers available for this request.',
      holdMs: 60_000,
    });
  }

  if (/\[Node\]\s+Discovering peers/i.test(line)) {
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'discovering-peers',
      message: 'Discovering peers from DHT...',
      holdMs: 12_000,
    });
  }

  const dhtResultMatch = /\[Node\]\s+DHT returned\s+(\d+)\s+result\(s\)/i.exec(line);
  if (dhtResultMatch) {
    const count = Number(dhtResultMatch[1] ?? 0);
    return toRuntimeActivity({
      mode: 'connect',
      tone: count > 0 ? 'active' : 'warn',
      stage: 'dht-results',
      message: `DHT discovery returned ${String(count)} peer result${count === 1 ? '' : 's'}.`,
      holdMs: 12_000,
    });
  }

  if (/\[proxy\]\s+POST \/v1\/messages/i.test(line)) {
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'chat-request',
      message: 'Submitting chat request to buyer proxy...',
      holdMs: 18_000,
    });
  }

  if (/\[proxy\]\s+GET \/v1\/models/i.test(line)) {
    return toRuntimeActivity({
      mode: 'connect',
      tone: 'warn',
      stage: 'service-request',
      message: 'Loading available services from peers...',
      holdMs: 20_000,
    });
  }

  return null;
}

function parseDashboardRuntimeActivity(lineRaw: string): RuntimeActivityEvent | null {
  const line = stripAnsi(lineRaw).trim().toLowerCase();
  if (line.length === 0) {
    return null;
  }

  if (line.includes('embedded dashboard engine running on http://127.0.0.1')) {
    return toRuntimeActivity({
      mode: 'dashboard',
      tone: 'active',
      stage: 'dashboard-ready',
      message: 'Local data service is ready.',
      holdMs: 10_000,
    });
  }

  if (line.includes('address already in use') || line.includes('eaddrinuse')) {
    return toRuntimeActivity({
      mode: 'dashboard',
      tone: 'warn',
      stage: 'dashboard-reuse',
      message: 'Local data service port is busy; using existing service.',
      holdMs: 20_000,
    });
  }

  return null;
}

function parseRuntimeActivityFromLog(event: LogEvent): RuntimeActivityEvent | null {
  if (event.mode === 'connect') {
    return parseConnectRuntimeActivity(event.line);
  }
  if (event.mode === 'dashboard') {
    return parseDashboardRuntimeActivity(event.line);
  }
  return null;
}

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
  mainWindow?.webContents.send('runtime:activity', activity);
}

function appendLog(mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string): void {
  const event: LogEvent = { mode, stream, line, timestamp: Date.now() };
  logBuffer.push(event);
  if (logBuffer.length > 1200) {
    logBuffer.splice(0, logBuffer.length - 1200);
  }

  mainWindow?.webContents.send('runtime:log', event);
  const activity = parseRuntimeActivityFromLog(event);
  if (activity) {
    emitRuntimeActivity(activity);
  }
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

function resolveNpmBin(): string {
  // Electron apps on macOS get a restricted PATH that may not include npm.
  // Check common locations before falling back to plain 'npm'.
  const candidates = [
    '/usr/local/bin/npm',          // Homebrew (Intel Mac)
    '/opt/homebrew/bin/npm',       // Homebrew (Apple Silicon)
    '/usr/bin/npm',                // System
    path.join(homedir(), '.nvm', 'alias', 'default', 'bin', 'npm'), // nvm symlink
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'npm'; // fallback — rely on PATH
}

async function installPluginDependency(packageSpec: string): Promise<void> {
  await ensurePluginsDirectory();
  const npmBin = resolveNpmBin();
  appendLog('connect', 'system', `Installing "${packageSpec}" via ${npmBin}...`);
  await execFileAsync(npmBin, ['install', '--ignore-scripts', packageSpec], {
    cwd: DEFAULT_PLUGINS_DIR,
    timeout: 120_000, // 2-minute hard limit
    env: {
      ...process.env,
      PATH: [
        '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
        process.env['PATH'] ?? '',
      ].join(':'),
    },
  });
}

async function installPluginFromBundle(packageName: string): Promise<boolean> {
  // In production builds, plugins are bundled into Resources/bundled-plugins/.
  const bundleRoot = path.join(process.resourcesPath ?? '', 'bundled-plugins');
  if (!existsSync(path.join(bundleRoot, packageName))) return false;

  await ensurePluginsDirectory();
  const destRoot = path.join(DEFAULT_PLUGINS_DIR, 'node_modules');

  // Copy all scoped packages from the bundle (target + its bundled dependencies).
  const bundleEntries = await readdir(bundleRoot, { withFileTypes: true });
  const scopeDirs = bundleEntries.filter((e) => e.isDirectory() && e.name.startsWith('@'));

  for (const scope of scopeDirs) {
    const pkgEntries = await readdir(path.join(bundleRoot, scope.name), { withFileTypes: true });
    for (const pkg of pkgEntries.filter((e) => e.isDirectory())) {
      const src = path.join(bundleRoot, scope.name, pkg.name);
      const dest = path.join(destRoot, scope.name, pkg.name);
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(src, dest, { recursive: true, force: true });
      appendLog('connect', 'system', `Copied bundled plugin ${scope.name}/${pkg.name}.`);
    }
  }

  return existsSync(path.join(destRoot, packageName, 'package.json'));
}

function isPluginInstalled(packageName: string): boolean {
  const pluginDir = path.join(DEFAULT_PLUGINS_DIR, 'node_modules', packageName);
  return existsSync(path.join(pluginDir, 'package.json'));
}

async function ensureDefaultPlugin(packageName: string): Promise<void> {
  if (isPluginInstalled(packageName)) {
    appSetupNeeded = false;
    appSetupComplete = true;
    return;
  }
  appSetupNeeded = true;
  mainWindow?.webContents.send('app:setup-step', { step: 'installing', label: 'Installing router plugin' });
  appendLog('connect', 'system', `Required plugin "${packageName}" not found. Installing`);
  try {
    // 1. Try copying from the app bundle (production builds — instant, no network)
    const installedFromBundle = await installPluginFromBundle(packageName);
    if (installedFromBundle) {
      appendLog('connect', 'system', `Installed plugin "${packageName}" from app bundle.`);
    } else {
      // 2. Try local monorepo source (dev builds)
      const localSource = await resolveLocalPluginSource(packageName);
      appendLog('connect', 'system', localSource ? `Using local source: ${localSource}` : `Using npm registry (${resolveNpmBin()})...`);
      if (localSource) {
        await installPluginDependency(toFileInstallSpec(packageName, localSource));
      } else {
        // 3. Fall back to npm registry
        await installPluginDependency(packageName);
      }
    }
    appendLog('connect', 'system', `Installed plugin "${packageName}".`);
    appSetupComplete = true;
    mainWindow?.webContents.send('app:setup-step', { step: 'done', label: 'Router plugin ready' });
    mainWindow?.webContents.send('app:setup-complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog('connect', 'system', `Failed to auto-install plugin "${packageName}": ${message}`);
    mainWindow?.webContents.send('app:setup-step', { step: 'error', label: 'Failed to install router plugin' });
    // Do NOT emit app:setup-complete on failure — the onAppSetupComplete handler
    // would unconditionally start the connect process even though the plugin is
    // not available, producing a spurious "Buyer runtime exited unexpectedly" message.
    throw new Error(`Required plugin "${packageName}" could not be installed: ${message}`);
  }
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
    },
    ...macosWindowChrome,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Allow Coinbase wallet popups (QR code, auth flows)
    if (
      url.includes('coinbase.com') ||
      url.includes('wallet.coinbase.com') ||
      url.includes('keys.coinbase.com') ||
      url.startsWith('about:blank')  // Coinbase SDK opens about:blank first
    ) {
      return { action: 'allow' };
    }
    // All other links open in system browser
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

  const startOptions: StartOptions = {
    ...options,
    ...(desktopDebugEnabled ? { verbose: true } : {}),
    env: {
      ...(options.env ?? {}),
      ...(desktopDebugEnabled ? { ANTSEED_DEBUG: '1' } : {}),
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

ipcMain.handle('desktop:set-debug-logs', (_event, enabled: boolean) => {
  desktopDebugEnabled = Boolean(enabled);
  return { ok: true };
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

ipcMain.handle('app:get-setup-status', () => ({
  needed: appSetupNeeded,
  complete: appSetupComplete,
}));

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
  'runtime:update-dashboard-config',
  async (_event, config: Record<string, unknown>, options?: { port?: number }): Promise<DashboardApiResult> => {
    const safeConfig = sanitizeDashboardConfigPayload(config);
    if (Object.keys(safeConfig).length === 0) {
      return { ok: false, data: null, error: 'No valid config keys provided', status: null };
    }
    const requestedPort = toSafeDashboardPort(options?.port);
    await ensureDashboardRuntime(requestedPort);
    const activePort = dashboardRuntime.running ? dashboardRuntime.port : requestedPort;
    return updateDashboardConfig(safeConfig, activePort);
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


// ── Wallet: SpendingAuth IPC ──
ipcMain.handle('wallet:send-spending-auth', async (_event, payload) => {
  console.log('[Wallet] SpendingAuth received:', JSON.stringify(payload).slice(0, 200));
  // TODO: Wire to BuyerPaymentManager.authorizeSpending via the running CLI subprocess
  return { ok: true };
});

// ── AI Chat IPC Handlers ──
registerPiChatHandlers({
  ipcMain,
  sendToRenderer: (channel, payload) => {
    mainWindow?.webContents.send(channel, payload);
  },
  configPath: ACTIVE_CONFIG_PATH,
  isBuyerRuntimeRunning: () => getCombinedProcessState().some((state) => state.mode === "connect" && state.running),
  appendSystemLog: (line) => {
    appendLog("dashboard", "system", line);
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
        host: typeof peer.host === "string" ? peer.host.trim() : "",
        port: Number(peer.port) || 0,
        providers: Array.isArray(peer.providers) ? peer.providers.map((provider) => String(provider)) : [],
      }))
      .filter((peer) => peer.host.length > 0
        && isPublicMetadataHost(peer.host)
        && peer.port > 0
        && peer.port <= 65535);
  },
});

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

  void ensureDefaultPlugin('@antseed/router-local').catch(() => {
    // Failure is already logged via appendLog inside ensureDefaultPlugin.
  });

  // Auto-update: check for updates silently on launch and every 4 hours
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('app:update-status', { status: 'ready', version: info.version });
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

// Ensure child processes are cleaned up if the main process receives SIGTERM
// (e.g. dev runner Ctrl+C kills Electron before before-quit fires).
process.on('SIGTERM', () => {
  void Promise.allSettled([
    stopDashboardRuntime('SIGTERM'),
    processManager.stopAll(),
  ]).finally(() => process.exit(0));
});
