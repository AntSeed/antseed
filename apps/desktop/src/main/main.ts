import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  net as electronNet,
  type OpenDialogOptions,
  type MenuItemConstructorOptions,
} from 'electron';
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, isIP } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
  type StartOptions,
  resolveConnectDataDir,
} from './process-manager.js';
import { registerPiChatHandlers, invalidateOnChainEnrichmentCache } from './pi-chat-engine.js';
import { ensureSecureIdentity, secureIdentityEnv, getSecureIdentity } from './identity.js';
import { DepositsClient, signSpendingAuth, makeChannelsDomain, resolveChainConfig, formatUsdc, peerIdToAddress } from '@antseed/node';
import { createServer as createPaymentsServer } from '@antseed/payments';
import type { LogEvent, RuntimeActivityEvent } from './log-parser.js';
import { parseRuntimeActivityFromLog, stripAnsi } from './log-parser.js';
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
import { createWindow, createApplicationMenu, getMainWindow, applyWindowView } from './window.js';
import { createDesktopTray, updateDesktopTray } from './tray.js';
import { ensureConfig, readConfig, mergeConfig, readNodeStatus } from './config-io.js';
import { registerAttachmentScheme, installAttachmentProtocol } from './attachment-protocol.js';
import { resolveAttachmentPath } from './attachment-store.js';
import { getWorkspacePickerDefaultDir } from './chat-workspace.js';
import {
  getVoiceTranscriptionStatus,
  installVoiceTranscriptionModel,
  setVoiceTranscriptionModel,
  transcribeVoiceAudio,
} from './voice-transcription.js';

// Re-export types that may be used by other main-process modules
export type { LogEvent, RuntimeActivityEvent } from './log-parser.js';
export type { DashboardNetworkPeer, DashboardNetworkStats, DashboardNetworkResult } from './peer-cache.js';
export type { InstalledPlugin } from './plugins.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SYSTEM_PROXY_PORT = 8378;
const DEFAULT_BUYER_PROXY_PORT = 8377;
const SYSTEM_PROXY_PROFILES_JSON_ENV = 'ANTSEED_SYSTEM_PROXY_PROFILES_JSON';
const SYSTEM_PROXY_PROFILES_FILE_ENV = 'ANTSEED_SYSTEM_PROXY_PROFILES_FILE';
const PACKAGED_SYSTEM_PROXY_PROFILES_RELATIVE = 'system-proxy-profiles.json';

type ConfigPatchDef = {
  readonly configPath: string;
  readonly providerKey: string;
  readonly npm: string;
  readonly providerName: string;
  readonly baseURL: string;
  readonly modelFormat: 'peer-routed';
};

type DesktopSystemProxyProfile = {
  readonly name: string;
  readonly label: string;
  readonly kind: 'proxy' | 'config-patch';
  readonly method: string;
  readonly domains: readonly string[];
  readonly appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app';
  readonly openUrl?: string;
  readonly toolName?: string;
  readonly restartAppName?: string;
  readonly configPatch?: ConfigPatchDef;
};

const SYSTEM_PROXY_PROFILES = loadDesktopSystemProxyProfiles();

type JsonObject = Record<string, unknown>;

function loadDesktopSystemProxyProfiles(env: NodeJS.ProcessEnv = process.env): readonly DesktopSystemProxyProfile[] {
  const envJson = env[SYSTEM_PROXY_PROFILES_JSON_ENV]?.trim();
  const envFile = env[SYSTEM_PROXY_PROFILES_FILE_ENV]?.trim();
  const packagedFile = packagedSystemProxyProfilesPath();
  const raw = envJson
    || (envFile ? readFileSync(envFile, 'utf8') : '')
    || (packagedFile ? readFileSync(packagedFile, 'utf8') : '');
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${SYSTEM_PROXY_PROFILES_JSON_ENV} / ${SYSTEM_PROXY_PROFILES_FILE_ENV} must define a JSON array`);
  }
  return parsed.map((profile, index) => normalizeDesktopSystemProxyProfile(profile, index));
}

function packagedSystemProxyProfilesPath(): string | null {
  if (!app.isPackaged || typeof process.resourcesPath !== 'string') return null;
  const filePath = path.join(process.resourcesPath, PACKAGED_SYSTEM_PROXY_PROFILES_RELATIVE);
  return existsSync(filePath) ? filePath : null;
}

function systemProxyProfilesEnv(): Record<string, string> {
  if (process.env[SYSTEM_PROXY_PROFILES_JSON_ENV]?.trim()) {
    return { [SYSTEM_PROXY_PROFILES_JSON_ENV]: process.env[SYSTEM_PROXY_PROFILES_JSON_ENV]! };
  }
  if (process.env[SYSTEM_PROXY_PROFILES_FILE_ENV]?.trim()) {
    return { [SYSTEM_PROXY_PROFILES_FILE_ENV]: process.env[SYSTEM_PROXY_PROFILES_FILE_ENV]! };
  }
  const packaged = packagedSystemProxyProfilesPath();
  return packaged ? { [SYSTEM_PROXY_PROFILES_FILE_ENV]: packaged } : {};
}

function normalizeDesktopSystemProxyProfile(value: unknown, index: number): DesktopSystemProxyProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`System Proxy profile at index ${index} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const name = readRequiredString(raw, 'name', index);
  const label = readString(raw, 'displayName') ?? readString(raw, 'label') ?? `Tool ${index + 1}`;
  const kind = raw['kind'] === 'config-patch' ? 'config-patch' : 'proxy';
  const configPatch = readConfigPatch(raw['configPatch'], name);
  const appAction = readAppAction(raw['appAction']);
  const openUrl = readString(raw, 'openUrl');
  const toolName = readString(raw, 'toolName');
  const restartAppName = readString(raw, 'restartAppName');
  return {
    name,
    label,
    kind,
    method: readString(raw, 'method') ?? (kind === 'config-patch' ? 'Config' : 'Proxy'),
    domains: readStringArray(raw['domains']),
    ...(appAction ? { appAction } : {}),
    ...(openUrl ? { openUrl } : {}),
    ...(toolName ? { toolName } : {}),
    ...(restartAppName ? { restartAppName } : {}),
    ...(configPatch ? { configPatch } : {}),
  };
}

function readConfigPatch(value: unknown, profileName: string): ConfigPatchDef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`configPatch for ${profileName} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  return {
    configPath: readRequiredString(raw, 'configPath', profileName),
    providerKey: readRequiredString(raw, 'providerKey', profileName),
    npm: readRequiredString(raw, 'npm', profileName),
    providerName: readRequiredString(raw, 'providerName', profileName),
    baseURL: readRequiredString(raw, 'baseURL', profileName),
    modelFormat: 'peer-routed',
  };
}

function readRequiredString(raw: Record<string, unknown>, key: string, context: string | number): string {
  const value = readString(raw, key);
  if (!value) throw new Error(`System Proxy profile ${context} requires ${key}`);
  return value;
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readAppAction(value: unknown): DesktopSystemProxyProfile['appAction'] {
  return value === 'open-url' || value === 'open-tool' || value === 'restart-app' || value === 'none'
    ? value
    : undefined;
}

function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

function isBuyerProxyRoutablePeerId(peerId: string): boolean {
  const normalized = peerId.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{40}$/.test(normalized);
}

function stripJsoncComments(raw: string): string {
  let result = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) result += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        result += raw[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i++;
      continue;
    }
    result += ch;
  }
  return result;
}

function stripJsoncTrailingCommas(raw: string): string {
  let result = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === '}' || raw[j] === ']') {
        continue;
      }
    }
    result += ch;
  }
  return result;
}

function parseJsoncObject(raw: string, filePath: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(raw)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to parse JSONC config at ${filePath}: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSONC config at ${filePath} must be an object`);
  }
  return parsed as JsonObject;
}

function readJsoncFile(filePath: string): JsonObject | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return parseJsoncObject(raw, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function readConfigPatchFile(filePath: string): JsonObject {
  if (!existsSync(filePath)) {
    return {};
  }
  return readJsoncFile(filePath) ?? {};
}

function tryReadConfigPatchFile(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return readJsoncFile(filePath);
}

function writeJsonFile(filePath: string, data: JsonObject): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function backupConfigFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.antseed.bak`;
  if (existsSync(backupPath)) return;
  copyFileSync(filePath, backupPath);
}

/** Remove a value from a top-level string array (e.g. drop "antseed" from disabled_providers). */
function removeFromStringArray(config: JsonObject, key: string, value: string): void {
  const arr = config[key];
  if (!Array.isArray(arr)) return;
  const filtered = arr.filter((item) => item !== value);
  if (filtered.length === 0) delete config[key];
  else config[key] = filtered;
}

function buildConfigPatchModels(
  patch: ConfigPatchDef,
  peerId: string,
  model: string,
  servedModels: string[],
): JsonObject {
  const models: JsonObject = {};
  if (patch.modelFormat === 'peer-routed') {
    for (const svc of servedModels) {
      const key = peerId ? `${peerId}@${svc}` : svc;
      models[key] = { name: svc };
    }
    if (model) {
      const key = peerId ? `${peerId}@${model}` : model;
      if (!models[key]) models[key] = { name: model };
    }
  }
  return models;
}

function routedModelKey(peerId: string, model: string): string {
  return peerId ? `${peerId}@${model}` : model;
}

function applyConfigPatch(patch: ConfigPatchDef, peerId: string, model: string, buyerPort: number, servedModels: string[]): void {
  if (!isBuyerProxyRoutablePeerId(peerId)) {
    throw new Error('Config-based routing requires a 40-character hex peer ID. Select a chain-backed peer before enabling this tool.');
  }
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const selectedModel = routedModelKey(peerId, model);
  const config = readConfigPatchFile(filePath);

  const providers = (config['provider'] && typeof config['provider'] === 'object' && !Array.isArray(config['provider']))
    ? config['provider'] as JsonObject
    : {};
  providers[patch.providerKey] = {
    name: patch.providerName,
    npm: patch.npm,
    options: {
      baseURL: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
      apiKey: 'antseed',
    },
    models: buildConfigPatchModels(patch, peerId, model, servedModels),
  };
  config['provider'] = providers;
  config['model'] = `${patch.providerKey}/${selectedModel}`;
  // Some tools hide providers listed in disabled_providers; make sure ours is enabled.
  removeFromStringArray(config, 'disabled_providers', patch.providerKey);

  writeJsonFile(filePath, config);
}

function removeConfigPatch(patch: ConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  backupConfigFile(filePath);

  let changed = false;
  const providers = config['provider'];
  if (providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    delete (providers as JsonObject)[patch.providerKey];
    changed = true;
  }
  // Drop our default-model selection if it points at our provider.
  if (typeof config['model'] === 'string' && config['model'].startsWith(`${patch.providerKey}/`)) {
    delete config['model'];
    changed = true;
  }
  if (!changed) return false;
  writeJsonFile(filePath, config);
  return true;
}

function removeAllConfigPatches(): void {
  for (const profile of SYSTEM_PROXY_PROFILES) {
    if (profile.kind !== 'config-patch' || !profile.configPatch) continue;
    removeConfigPatch(profile.configPatch);
  }
}

let lastSystemProxySetupAt: number | null = null;
let traySystemProxyPeerId = '';
let traySystemProxyModel = '';
let traySystemProxyProfiles = new Set<string>();
let activeSystemProxyState: (RuntimeProcessState & Record<string, unknown>) | null = null;

type SystemProxyGuiTestResult = {
  ok: boolean;
  proxyConfigured: boolean;
  proxyReachable: boolean;
  guiTrustOk: boolean;
  appRunning: boolean;
  needsAppRestart: boolean;
  appPid?: number;
  statusCode?: number;
  error?: string;
};

function systemProxyDataDir(): string {
  return path.join(resolveConnectDataDir(), 'system-proxy');
}

function systemProxyHookPath(): string {
  return path.join(systemProxyDataDir(), 'node-proxy-hook.cjs');
}

function systemProxyCaPath(): string {
  return path.join(systemProxyDataDir(), 'ca.crt');
}

function systemProxyPidPath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.pid');
}

function systemProxyStatePath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.state.json');
}

function systemProxySnapshotPath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.snapshot.json');
}

function readSystemProxyRuntimeMetadata(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(systemProxyStatePath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function loadPersistedSystemProxyState(): void {
  const metadata = readSystemProxyRuntimeMetadata();
  const activeProfileNames = Array.isArray(metadata['activeProfileNames'])
    ? metadata['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const peerId = typeof metadata['peerId'] === 'string' ? metadata['peerId'] : '';
  const defaultModel = typeof metadata['defaultModel'] === 'string' ? metadata['defaultModel'] : '';
  if (activeProfileNames.length === 0 || !peerId) return;
  activeSystemProxyState = {
    mode: 'system-proxy',
    running: activeProfileNames.some((name) => isConfigPatchProfileName(name)),
    pid: null,
    startedAt: Date.now(),
    lastExitCode: null,
    lastError: null,
    port: Number(metadata['port']) || DEFAULT_SYSTEM_PROXY_PORT,
    peerId,
    defaultModel,
    activeProfileNames,
    toolRoutes: metadata['toolRoutes'],
  };
  traySystemProxyPeerId = peerId;
  traySystemProxyModel = defaultModel;
  traySystemProxyProfiles = new Set(activeProfileNames);
}

function withSystemProxyRuntimeMetadata(state: RuntimeProcessState | null): RuntimeProcessState | null {
  if (!state) return null;
  if (state.mode !== 'system-proxy') return state;
  return { ...state, ...readSystemProxyRuntimeMetadata(), running: state.running };
}

function getSystemProxyProcessState(): RuntimeProcessState | null {
  const processState = processManager.getState().find((s) => s.mode === 'system-proxy') ?? null;
  if (!activeSystemProxyState) {
    return withSystemProxyRuntimeMetadata(processState);
  }
  const activeProfiles = Array.isArray(activeSystemProxyState['activeProfileNames'])
    ? activeSystemProxyState['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const hasConfigPatch = activeProfiles.some((name) => isConfigPatchProfileName(name));
  const running = processState?.running === true || hasConfigPatch;
  return {
    ...activeSystemProxyState,
    ...(processState ?? {}),
    running,
    pid: processState?.pid ?? null,
    lastExitCode: processState?.lastExitCode ?? activeSystemProxyState.lastExitCode ?? null,
    lastError: processState?.lastError ?? activeSystemProxyState.lastError ?? null,
  };
}

async function setActiveSystemProxyState(state: RuntimeProcessState & Record<string, unknown>): Promise<void> {
  activeSystemProxyState = state;
  await mkdir(systemProxyDataDir(), { recursive: true }).catch(() => undefined);
  await writeFile(systemProxyStatePath(), JSON.stringify({
    port: state['port'],
    peerId: state['peerId'],
    defaultModel: state['defaultModel'],
    activeProfileNames: state['activeProfileNames'],
    toolRoutes: state['toolRoutes'],
    running: state.running,
  }), 'utf8').catch(() => undefined);
}

function runtimeMetadata(state: RuntimeProcessState | null): Record<string, unknown> {
  return state ? state as unknown as Record<string, unknown> : {};
}

function shortTrayPeerId(peerId: string): string {
  return peerId.length > 12 ? `${peerId.slice(0, 8)}...${peerId.slice(-4)}` : peerId;
}

function getTrayPeerOptions(): DashboardNetworkPeer[] {
  return getNetworkSnapshot().peers
    .filter((peer) => peer.peerId.length > 0)
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.displayName || a.peerId).localeCompare(b.displayName || b.peerId);
    });
}

function getTraySelectedPeer(): DashboardNetworkPeer | null {
  const state = getSystemProxyProcessState();
  const metadata = runtimeMetadata(state);
  const statePeerId = typeof metadata['peerId'] === 'string' ? metadata['peerId'] : '';
  const selectedId = statePeerId || traySystemProxyPeerId;
  return selectedId ? lookupPeer(selectedId) : null;
}

function getTraySelectedModel(): string {
  const state = getSystemProxyProcessState();
  const metadata = runtimeMetadata(state);
  return (typeof metadata['defaultModel'] === 'string' && metadata['defaultModel'].length > 0)
    ? metadata['defaultModel']
    : traySystemProxyModel;
}

function getTrayProfilesFromState(): Set<string> {
  const state = getSystemProxyProcessState();
  const metadata = runtimeMetadata(state);
  const active = Array.isArray(metadata['activeProfileNames'])
    ? metadata['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  return new Set(active.length > 0 ? active : traySystemProxyProfiles);
}

function isCertificateTrustError(message: string): boolean {
  return /certificate|cert_|err_cert|authority|trust|ssl|tls/i.test(message);
}

function getMacAppProcessInfo(appName: string): { running: boolean; pid?: number; startedAt?: number } {
  if (process.platform !== 'darwin') {
    return { running: false };
  }
  try {
    const raw = execFileSync('pgrep', ['-x', appName], { encoding: 'utf8' }).trim();
    const firstLine = raw.split('\n')[0]?.trim() ?? '';
    const pid = Number(firstLine);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { running: false };
    }
    let startedAt: number | undefined;
    try {
      const startRaw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
      const parsed = Date.parse(startRaw);
      if (Number.isFinite(parsed)) {
        startedAt = parsed;
      }
    } catch { /* best-effort */ }
    return { running: true, pid, startedAt };
  } catch {
    return { running: false };
  }
}

async function restartMacApp(appName: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: `${appName} restart is currently supported on macOS only.` };
  }
  try {
    try {
      execFileSync('osascript', ['-e', `tell application "${appName}" to quit`], { stdio: 'pipe' });
    } catch {
      // Continue: the app may not be running or may not respond to AppleScript.
    }
    const startedWaitingAt = Date.now();
    while (Date.now() - startedWaitingAt < 10_000 && getMacAppProcessInfo(appName).running) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (getMacAppProcessInfo(appName).running) {
      execFileSync('pkill', ['-x', appName], { stdio: 'pipe' });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    execFileSync('open', ['-a', appName], { stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function getEnabledNetworkServices(): string[] {
  try {
    const out = execFileSync('networksetup', ['-listallnetworkservices'], { encoding: 'utf8' });
    const services = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('*') && !line.includes('denotes'));
    return services.length > 0 ? services : ['Wi-Fi'];
  } catch {
    return ['Wi-Fi'];
  }
}

function getSystemProxyServices(port = DEFAULT_SYSTEM_PROXY_PORT): string[] {
  if (process.platform !== 'darwin') {
    return [];
  }
  const matches: string[] = [];
  for (const service of getEnabledNetworkServices()) {
    try {
      const out = execFileSync('networksetup', ['-getsecurewebproxy', service], { encoding: 'utf8' });
      if (out.includes('Enabled: Yes') && out.includes('Server: 127.0.0.1') && out.includes(`Port: ${port}`)) {
        matches.push(service);
      }
    } catch { /* best-effort */ }
  }
  return matches;
}

function canConnectToLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForSystemProxyReady(port: number, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  let lastRunning = true;
  while (Date.now() - startedAt < timeoutMs) {
    const state = processManager.getState().find((entry) => entry.mode === 'system-proxy');
    lastRunning = state?.running === true;
    if (!lastRunning) break;
    if (await canConnectToLocalPort(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const state = processManager.getState().find((entry) => entry.mode === 'system-proxy');
  const detail = state?.lastError
    ? ` Last error: ${state.lastError}`
    : state?.lastExitCode !== null && state?.lastExitCode !== undefined
      ? ` Process exited with code ${state.lastExitCode}.`
      : lastRunning
        ? ''
        : ' Process exited before becoming ready.';
  throw new Error(`System Proxy did not become ready on 127.0.0.1:${port}.${detail}`);
}

function setSystemProxyNodeEnv(port: number): void {
  const caPath = systemProxyCaPath();
  const hookFile = systemProxyHookPath();
  const cmds: [string, string[]][] = [];
  if (process.platform === 'darwin') {
    cmds.push(['launchctl', ['setenv', 'HTTPS_PROXY', `http://localhost:${port}`]]);
    cmds.push(['launchctl', ['setenv', 'NODE_EXTRA_CA_CERTS', caPath]]);
    cmds.push(['launchctl', ['setenv', 'NODE_OPTIONS', `--require ${hookFile}`]]);
  } else if (process.platform === 'win32') {
    cmds.push(['setx', ['HTTPS_PROXY', `http://localhost:${port}`]]);
    cmds.push(['setx', ['NODE_EXTRA_CA_CERTS', caPath]]);
    cmds.push(['setx', ['NODE_OPTIONS', `--require ${hookFile}`]]);
  }
  for (const [cmd, args] of cmds) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe' });
    } catch (err) {
      // Log so the Logs tab shows the failure
      console.error(`[system-proxy] env setup failed: ${cmd} ${args.join(' ')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function firstProbeUrl(): string | null {
  const profile = SYSTEM_PROXY_PROFILES.find((item) => item.kind === 'proxy' && item.domains.length > 0);
  const domain = profile?.domains[0];
  return domain ? `https://${domain}/` : null;
}

function restartTargetProcessInfo(): { running: boolean; pid?: number; startedAt?: number } {
  const appName = SYSTEM_PROXY_PROFILES.find((item) => item.restartAppName)?.restartAppName;
  return appName ? getMacAppProcessInfo(appName) : { running: false };
}

async function runGuiSystemProxyTrustProbe(): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const url = firstProbeUrl();
  if (!url) {
    return { ok: false, error: 'No proxy-based System Proxy profiles are configured.' };
  }
  return await new Promise((resolve) => {
    const request = electronNet.request({
      method: 'GET',
      url,
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: { ok: boolean; statusCode?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      request.abort();
      finish({ ok: false, error: 'GUI network test timed out.' });
    }, 8_000);
    request.on('response', (response) => {
      response.on('data', () => undefined);
      response.on('end', () => finish({ ok: true, statusCode: response.statusCode }));
    });
    request.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
    request.end();
  });
}

function clearOsSystemProxy(port = DEFAULT_SYSTEM_PROXY_PORT): void {
  if (process.platform === 'darwin') {
    for (const service of getEnabledNetworkServices()) {
      try {
        const out = execFileSync('networksetup', ['-getsecurewebproxy', service], { encoding: 'utf8' });
        if (!out.includes('Server: 127.0.0.1') || !out.includes(`Port: ${port}`)) {
          continue;
        }
        execFileSync('networksetup', ['-setsecurewebproxystate', service, 'off'], { stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
  } else if (process.platform === 'win32') {
    try {
      execFileSync('reg', [
        'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f',
      ], { stdio: 'pipe' });
    } catch { /* best-effort */ }
  }
}

function restoreOsSystemProxySnapshot(rawSnapshot: unknown): boolean {
  if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) return false;
  const snapshot = rawSnapshot as Record<string, unknown>;
  if (snapshot['platform'] === 'darwin') {
    const services = Array.isArray(snapshot['services']) ? snapshot['services'] : [];
    for (const rawService of services) {
      if (!rawService || typeof rawService !== 'object' || Array.isArray(rawService)) continue;
      const service = rawService as Record<string, unknown>;
      const name = typeof service['service'] === 'string' ? service['service'] : '';
      const server = typeof service['server'] === 'string' ? service['server'] : '';
      const port = typeof service['port'] === 'string' ? service['port'] : '';
      const enabled = service['enabled'] === true;
      if (!name) continue;
      try {
        if (server && port) {
          execFileSync('networksetup', ['-setsecurewebproxy', name, server, port], { stdio: 'pipe' });
        }
        execFileSync('networksetup', ['-setsecurewebproxystate', name, enabled ? 'on' : 'off'], { stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
    return true;
  }
  if (snapshot['platform'] === 'win32') {
    const proxyEnable = typeof snapshot['proxyEnable'] === 'string' ? snapshot['proxyEnable'] : '0';
    const proxyServer = typeof snapshot['proxyServer'] === 'string' ? snapshot['proxyServer'] : '';
    try {
      execFileSync('reg', [
        'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', proxyEnable, '/f',
      ], { stdio: 'pipe' });
      if (proxyServer) {
        execFileSync('reg', [
          'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
          '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', proxyServer, '/f',
        ], { stdio: 'pipe' });
      } else {
        try {
          execFileSync('reg', [
            'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v', 'ProxyServer', '/f',
          ], { stdio: 'pipe' });
        } catch { /* missing value */ }
      }
    } catch { /* best-effort */ }
    return true;
  }
  return false;
}

async function restoreOsSystemProxy(port = DEFAULT_SYSTEM_PROXY_PORT): Promise<void> {
  try {
    const raw = readFileSync(systemProxySnapshotPath(), 'utf8');
    const restored = restoreOsSystemProxySnapshot(JSON.parse(raw) as unknown);
    if (restored) {
      await unlink(systemProxySnapshotPath()).catch(() => undefined);
      return;
    }
  } catch { /* no snapshot */ }
  clearOsSystemProxy(port);
}

async function clearSystemProxyRuntimeFiles(): Promise<void> {
  await Promise.all([
    unlink(systemProxyPidPath()).catch(() => undefined),
    unlink(systemProxyStatePath()).catch(() => undefined),
  ]);
  activeSystemProxyState = null;
}

async function clearSystemProxySettings(port = DEFAULT_SYSTEM_PROXY_PORT): Promise<void> {
  clearSystemProxyNodeEnv();
  await restoreOsSystemProxy(port);
  await clearSystemProxyRuntimeFiles();
  await removeSystemProxyFromShellProfiles();
}

async function stopManagedRuntimes(): Promise<void> {
  try {
    await processManager.stopAll();
  } finally {
    await clearSystemProxySettings();
  }
}

function removeSystemProxyShellBlock(content: string): string {
  // Remove the block between the start/end markers (inclusive), plus surrounding blank lines
  return content.replace(/\n*# AntSeed System Proxy\n[\s\S]*?# End AntSeed System Proxy\n*/g, '\n');
}

async function removeSystemProxyFromShellProfiles(): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const home = homedir();
  const candidates = [
    path.join(home, '.zshrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.bashrc'),
  ];
  for (const profilePath of candidates) {
    try {
      const existing = await readFile(profilePath, 'utf8');
      const cleaned = removeSystemProxyShellBlock(existing);
      if (cleaned !== existing) {
        await writeFile(profilePath, cleaned, 'utf8');
      }
    } catch { /* file doesn't exist or can't be read — skip */ }
  }
}

function clearSystemProxyNodeEnv(): void {
  if (process.platform === 'darwin') {
    for (const varName of ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS']) {
      try { execFileSync('launchctl', ['unsetenv', varName], { stdio: 'pipe' }); } catch { /* best-effort */ }
    }
  } else if (process.platform === 'win32') {
    for (const varName of ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS']) {
      try { execFileSync('setx', [varName, ''], { stdio: 'pipe' }); } catch { /* best-effort */ }
    }
  }
}

const isDev = Boolean(process.env['VITE_DEV_SERVER_URL']);
const rendererUrl = process.env['VITE_DEV_SERVER_URL'] ?? `file://${path.join(__dirname, '../renderer/index.html')}`;
const APP_NAME = 'AntStation Desktop';
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

// The `antseed-attachment://` scheme must be registered as privileged
// *before* `app.whenReady()` fires. The actual request handler is wired
// inside whenReady() once Electron's protocol module is usable.
registerAttachmentScheme();

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

function resolveTrayIconPath(): string | undefined {
  const candidates = [
    path.resolve(__dirname, '../../assets/antseed-mark.png'),
    path.resolve(process.cwd(), 'assets/antseed-mark.png'),
    path.resolve(__dirname, '../../assets/antseed-dock-icon.png'),
    path.resolve(process.cwd(), 'assets/antseed-dock-icon.png'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const APP_ICON_PATH = resolveAppIconPath();
const TRAY_ICON_PATH = resolveTrayIconPath();

// Set app name as early as possible; on macOS dev runs may still show "Electron"
// in some surfaces because the underlying bundle is Electron.app.
app.setName(APP_NAME);

import { DEFAULT_CONFIG_PATH, LOCALHOST, LOCALHOST_URL } from './constants.js';
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

async function resolveBuyerProxyPort(): Promise<number> {
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const buyer = asRecord(config['buyer']);
    const port = Number(buyer['proxyPort']);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  } catch {
    // Fall back to the default proxy port when config is unavailable.
  }
  return DEFAULT_BUYER_PROXY_PORT;
}

async function requestBuyerPeerRefresh(): Promise<void> {
  const port = await resolveBuyerProxyPort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${LOCALHOST_URL}:${port}/_antseed/peers/refresh`, {
      method: 'POST',
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }

    if (!response.ok || payload['ok'] !== true) {
      const error = typeof payload['error'] === 'string' && payload['error'].trim().length > 0
        ? payload['error']
        : `Buyer proxy returned HTTP ${response.status}`;
      throw new Error(error);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timed out refreshing peers via buyer proxy on port ${port}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to refresh peers via buyer proxy on port ${port}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
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
  if (mode === 'system-proxy' && stream === 'system' && /^Process exited|^Started system-proxy/.test(line)) {
    refreshTrayMenu();
  }
}

// Wire up callbacks for extracted modules
setPluginAppendLog(appendLog);

// When the peer set changes, tell the renderer to refresh the service catalog.
onPeersChanged(() => {
  getMainWindow()?.webContents.send('peers:changed');
  refreshTrayMenu();
});
const processManager = new ProcessManager((mode, stream, line) => {
  appendLog(mode, stream, line);
});

type SystemProxyStartRequest = {
  peerId: string;
  port?: number;
  profiles?: string[];
  defaultModel?: string;
  servedModels?: string[];
  toolRoutes?: Record<string, { peerId: string; model: string }>;
  profileSwitch?: boolean;
};

function routeForTool(opts: SystemProxyStartRequest, profileName: string): { peerId: string; model: string; services: string[] } {
  const route = opts.toolRoutes?.[profileName];
  const peerId = route?.peerId?.trim() || opts.peerId;
  const model = route?.model?.trim() || opts.defaultModel || '';
  const peer = lookupPeer(peerId);
  return { peerId, model, services: peer?.services ?? opts.servedModels ?? [] };
}

async function startSystemProxyRuntime(opts: SystemProxyStartRequest): Promise<RuntimeProcessState | null> {
  const port = opts.port ?? DEFAULT_SYSTEM_PROXY_PORT;
  const allProfiles = opts.profiles ?? [];
  const proxyProfiles = allProfiles.filter((name) => !isConfigPatchProfileName(name));
  const configPatchProfiles = allProfiles.filter((name) => isConfigPatchProfileName(name));
  const proxyRoute = proxyProfiles.length > 0 ? routeForTool(opts, proxyProfiles[0]!) : routeForTool(opts, allProfiles[0] ?? '');
  const previousProfiles = new Set(
    Array.isArray(activeSystemProxyState?.['activeProfileNames'])
      ? activeSystemProxyState['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
      : [...traySystemProxyProfiles],
  );

  for (const name of previousProfiles) {
    if (allProfiles.includes(name) || !isConfigPatchProfileName(name)) continue;
    const profile = SYSTEM_PROXY_PROFILES.find((p) => p.name === name);
    if (profile?.configPatch) {
      removeConfigPatch(profile.configPatch);
      appendLog('system-proxy', 'system', `${profile.label}: removed AntSeed provider from config`);
    }
  }

  const processState = processManager.getState().find((entry) => entry.mode === 'system-proxy');
  if (processState?.running) {
    await processManager.stop('system-proxy');
  }

  const buyerProxyPort = await resolveBuyerProxyPort();
  for (const name of configPatchProfiles) {
    const profile = SYSTEM_PROXY_PROFILES.find((p) => p.name === name);
    if (profile?.configPatch) {
      const route = routeForTool(opts, name);
      applyConfigPatch(profile.configPatch, route.peerId, route.model, buyerProxyPort, route.services);
      appendLog('system-proxy', 'system', `${profile.label}: connected by config patch (peer=${shortTrayPeerId(route.peerId)}, model=${route.model || 'auto'})`);
    }
  }

  let state: RuntimeProcessState | null = null;
  if (proxyProfiles.length > 0) {
    state = await processManager.start({
      mode: 'system-proxy',
      env: systemProxyProfilesEnv(),
      systemProxyPeerId: proxyRoute.peerId,
      systemProxyPort: opts.port,
      systemProxyProfiles: proxyProfiles,
      systemProxyDefaultModel: proxyRoute.model || undefined,
      systemProxyServedModels: proxyRoute.services,
      setSystemProxy: true,
    });
    try {
      await waitForSystemProxyReady(port);
    } catch (err) {
      await stopSystemProxyRuntime(true).catch(() => undefined);
      throw err;
    }
    setSystemProxyNodeEnv(port);
    if (!opts.profileSwitch) {
      lastSystemProxySetupAt = Date.now();
    }
  }

  traySystemProxyPeerId = opts.peerId;
  traySystemProxyModel = opts.defaultModel ?? '';
  traySystemProxyProfiles = new Set(allProfiles);
  refreshTrayMenu();
  const nextState = {
    ...(state ?? { mode: 'system-proxy' as const, running: configPatchProfiles.length > 0, pid: null, startedAt: Date.now(), lastExitCode: null, lastError: null }),
    port,
    peerId: opts.peerId,
    defaultModel: opts.defaultModel,
    toolRoutes: opts.toolRoutes,
    activeProfileNames: allProfiles,
    running: proxyProfiles.length > 0 ? state?.running === true : configPatchProfiles.length > 0,
  } as RuntimeProcessState & Record<string, unknown>;
  await setActiveSystemProxyState(nextState);
  return getSystemProxyProcessState();
}

async function restartSystemProxyRuntime(opts: SystemProxyStartRequest): Promise<RuntimeProcessState | null> {
  await processManager.stop('system-proxy');
  return startSystemProxyRuntime(opts);
}

async function stopSystemProxyRuntime(clearSettings: boolean): Promise<RuntimeProcessState | null> {
  const state = await processManager.stop('system-proxy');
  if (clearSettings) {
    await clearSystemProxySettings();
    removeAllConfigPatches();
    traySystemProxyProfiles = new Set();
    activeSystemProxyState = null;
  }
  refreshTrayMenu();
  return withSystemProxyRuntimeMetadata(state);
}

function openSystemProxyWindow(): void {
  const window = getMainWindow();
  if (window) {
    applyWindowView('system-proxy');
    window.show();
    window.focus();
  }
}

function resolveTrayPeerForStart(): DashboardNetworkPeer | null {
  return getTraySelectedPeer() ?? getTrayPeerOptions().find((peer) => peer.online) ?? getTrayPeerOptions()[0] ?? null;
}

function resolveTrayModelForPeer(peer: DashboardNetworkPeer | null): string {
  if (!peer) return '';
  const selected = getTraySelectedModel();
  return selected && peer.services.includes(selected) ? selected : peer.services[0] ?? selected;
}

async function setTrayPeer(peerId: string): Promise<void> {
  traySystemProxyPeerId = peerId;
  const peer = lookupPeer(peerId);
  traySystemProxyModel = resolveTrayModelForPeer(peer);
  const state = getSystemProxyProcessState();
  const profiles = getTrayProfilesFromState();
  if (state?.running && profiles.size > 0) {
    await restartSystemProxyRuntime({
      peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...profiles],
      defaultModel: traySystemProxyModel || undefined,
      servedModels: peer?.services ?? [],
      profileSwitch: true,
    });
  }
  refreshTrayMenu();
}

async function setTrayModel(model: string): Promise<void> {
  traySystemProxyModel = model;
  const peer = resolveTrayPeerForStart();
  const state = getSystemProxyProcessState();
  const profiles = getTrayProfilesFromState();
  if (state?.running && peer && profiles.size > 0) {
    await restartSystemProxyRuntime({
      peerId: peer.peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...profiles],
      defaultModel: model || undefined,
      servedModels: peer.services,
      profileSwitch: true,
    });
  }
  refreshTrayMenu();
}

function isConfigPatchProfileName(name: string): boolean {
  return SYSTEM_PROXY_PROFILES.find((p) => p.name === name)?.kind === 'config-patch';
}

async function setTrayProfile(profileName: string, enabled: boolean): Promise<void> {
  const next = getTrayProfilesFromState();
  if (enabled) next.add(profileName);
  else next.delete(profileName);

  const state = getSystemProxyProcessState();
  traySystemProxyProfiles = next;

  const peer = resolveTrayPeerForStart();

  if (isConfigPatchProfileName(profileName)) {
    if (!peer && enabled) {
      appendLog('system-proxy', 'system', 'Select a peer before connecting an app from the tray.');
      refreshTrayMenu();
      return;
    }
    if (next.size === 0) {
      await stopSystemProxyRuntime(true);
      refreshTrayMenu();
      return;
    }
    const selectedPeer = peer ?? getTraySelectedPeer();
    if (selectedPeer) {
      const model = resolveTrayModelForPeer(selectedPeer);
      traySystemProxyPeerId = selectedPeer.peerId;
      traySystemProxyModel = model;
      await startSystemProxyRuntime({
        peerId: selectedPeer.peerId,
        port: DEFAULT_SYSTEM_PROXY_PORT,
        profiles: [...next],
        defaultModel: model || undefined,
        servedModels: selectedPeer.services,
        profileSwitch: true,
      });
    }
    refreshTrayMenu();
    return;
  }

  const proxyProfiles = [...next].filter((name) => !isConfigPatchProfileName(name));
  if (proxyProfiles.length === 0) {
    if (state?.running) {
      await startSystemProxyRuntime({
        peerId: peer?.peerId ?? traySystemProxyPeerId,
        port: DEFAULT_SYSTEM_PROXY_PORT,
        profiles: [...next],
        defaultModel: peer ? resolveTrayModelForPeer(peer) || undefined : traySystemProxyModel || undefined,
        servedModels: peer?.services ?? [],
        profileSwitch: true,
      });
    }
    refreshTrayMenu();
    return;
  }

  if (!peer) {
    appendLog('system-proxy', 'system', 'Select a peer before connecting an app from the tray.');
    refreshTrayMenu();
    return;
  }
  const model = resolveTrayModelForPeer(peer);
  traySystemProxyPeerId = peer.peerId;
  traySystemProxyModel = model;

  if (state?.running) {
    await restartSystemProxyRuntime({
      peerId: peer.peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...next],
      defaultModel: model || undefined,
      servedModels: peer.services,
      profileSwitch: true,
    });
  } else {
    await startSystemProxyRuntime({
      peerId: peer.peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...next],
      defaultModel: model || undefined,
      servedModels: peer.services,
    });
  }
  refreshTrayMenu();
}

function buildSystemProxyTrayMenu(showMainWindow: () => void): MenuItemConstructorOptions[] {
  const state = getSystemProxyProcessState();
  const running = state?.running === true;
  const profiles = getTrayProfilesFromState();
  const peerOptions = getTrayPeerOptions();
  const selectedPeer = getTraySelectedPeer() ?? peerOptions[0] ?? null;
  const selectedModel = resolveTrayModelForPeer(selectedPeer);
  const peerLabel = selectedPeer
    ? `${selectedPeer.displayName || shortTrayPeerId(selectedPeer.peerId)} (${shortTrayPeerId(selectedPeer.peerId)})`
    : 'No peer selected';

  const peerSubmenu: MenuItemConstructorOptions[] = peerOptions.length > 0
    ? peerOptions.slice(0, 20).map((peer) => ({
      label: `${peer.displayName || shortTrayPeerId(peer.peerId)}${peer.online ? '' : ' (offline)'}`,
      type: 'radio',
      checked: selectedPeer?.peerId === peer.peerId,
      click: () => { void setTrayPeer(peer.peerId); },
    }))
    : [{ label: 'No discovered peers', enabled: false }];

  const modelOptions = selectedPeer?.services ?? [];
  const modelSubmenu: MenuItemConstructorOptions[] = modelOptions.length > 0
    ? modelOptions.slice(0, 30).map((model) => ({
      label: model,
      type: 'radio',
      checked: selectedModel === model,
      click: () => { void setTrayModel(model); },
    }))
    : [{ label: 'No models for selected peer', enabled: false }];

  return [
    { label: running ? 'System Proxy: Connected' : 'System Proxy: No tools connected', enabled: false },
    { label: `Peer: ${peerLabel}`, enabled: false },
    { label: `Model: ${selectedModel || 'No model selected'}`, enabled: false },
    { type: 'separator' },
    { label: 'Peer', submenu: peerSubmenu },
    { label: 'Model', submenu: modelSubmenu },
    { type: 'separator' },
    ...SYSTEM_PROXY_PROFILES.map((profile): MenuItemConstructorOptions => {
      const connected = profiles.has(profile.name) && (running || profile.kind === 'config-patch');
      return {
        label: `${profile.label}: ${connected ? 'Disconnect' : 'Connect'}`,
        enabled: selectedPeer !== null,
        click: () => { void setTrayProfile(profile.name, !connected); },
      };
    }),
    { type: 'separator' },
    { label: 'Open System Proxy', click: openSystemProxyWindow },
    { label: `Show ${APP_NAME}`, click: showMainWindow },
    ...(running ? [{ label: 'Disconnect All', click: () => { void stopSystemProxyRuntime(true); } } as MenuItemConstructorOptions] : []),
    { type: 'separator' },
    { role: 'quit', label: `Quit ${APP_NAME}` },
  ];
}

function refreshTrayMenu(): void {
  updateDesktopTray();
}

// ── Payments Portal ──

let paymentsServer: Awaited<ReturnType<typeof createPaymentsServer>> | null = null;
const PAYMENTS_PORT = Number(process.env['ANTSEED_PAYMENTS_PORT']) || 3118;

async function startPaymentsPortal(): Promise<void> {
  if (paymentsServer) return;
  try {
    await ensureSecureIdentity();
    const identityHex = secureIdentityEnv().ANTSEED_IDENTITY_HEX;
    paymentsServer = await createPaymentsServer({
      port: PAYMENTS_PORT,
      identityHex,
    });
    await paymentsServer.listen({ port: PAYMENTS_PORT, host: LOCALHOST });
    console.log(`[desktop] Payments portal running at ${LOCALHOST_URL}:${PAYMENTS_PORT}`);
  } catch (err) {
    console.error('[desktop] Failed to start payments portal:', err instanceof Error ? err.message : String(err));
    paymentsServer = null;
  }
}

async function stopPaymentsPortal(): Promise<void> {
  if (!paymentsServer) return;
  try {
    await paymentsServer.close();
  } catch {
    // Already closed
  }
  paymentsServer = null;
}

ipcMain.handle('payments:open-portal', async (_event, tab?: string) => {
  try {
    await startPaymentsPortal();
    const token = paymentsServer ? (paymentsServer as unknown as { bearerToken?: string }).bearerToken : '';
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (tab === 'deposit' || tab === 'deposits') {
      params.set('action', 'deposit');
    } else if (tab) {
      params.set('tab', tab);
    }
    const qs = params.toString();
    // In dev mode, open the Vite HMR dev server (which proxies /api to the Fastify port) when configured.
    // Set ANTSEED_PAYMENTS_DEV_URL to override (default: the Fastify URL).
    // When dev mode is detected but no dev server URL is configured, we still fall back to the Fastify URL.
    const devUrl = isDev ? process.env['ANTSEED_PAYMENTS_DEV_URL']?.trim() : undefined;
    const base = devUrl || `${LOCALHOST_URL}:${PAYMENTS_PORT}`;
    const url = qs ? `${base}?${qs}` : base;
    const { default: open } = await import('open');
    await open(url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function getCombinedProcessState(): RuntimeProcessState[] {
  return processManager.getState();
}

// ── IPC Handlers ──
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

ipcMain.handle('desktop:open-external-url', async (_event, rawUrl: string) => {
  try {
    const url = new URL(typeof rawUrl === 'string' ? rawUrl : '');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: 'Only http(s) URLs can be opened.' };
    }
    await shell.openExternal(url.toString());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:open-tool', async (_event, toolName: string) => {
  try {
    const key = typeof toolName === 'string' ? toolName : '';
    const profile = SYSTEM_PROXY_PROFILES.find((item) => item.name === key || item.toolName === key);
    if (!profile) {
      return { ok: false, error: 'Unknown tool.' };
    }
    if (profile.openUrl) {
      await shell.openExternal(profile.openUrl);
      return { ok: true, fallback: profile.openUrl };
    }
    if (profile.restartAppName && process.platform === 'darwin') {
      try {
        execFileSync('open', ['-a', profile.restartAppName], { stdio: 'pipe' });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: false, error: 'No open target configured for this tool.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('window:apply-view', (_event, viewName: string) => {
  return applyWindowView(typeof viewName === 'string' ? viewName : '');
});

ipcMain.handle('runtime:clear-logs', async () => {
  logBuffer.length = 0;
  return { ok: true };
});

ipcMain.handle(
  'attachment:download',
  async (
    _event,
    conversationId: string,
    attachmentId: string,
    suggestedName: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    // Download flow via dialog.showSaveDialog + copyFile. More reliable
    // cross-platform than relying on <a download> with a custom
    // Electron protocol URL — Chromium's save-to-disk path is only
    // guaranteed for http(s)/data/blob.
    try {
      const resolved = await resolveAttachmentPath(conversationId, attachmentId);
      if (!resolved) {
        return { ok: false, error: 'Attachment not found' };
      }
      const win = getMainWindow();
      const safeSuggested = typeof suggestedName === 'string' && suggestedName.trim().length > 0
        ? suggestedName.trim()
        : 'attachment';
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: safeSuggested })
        : await dialog.showSaveDialog({ defaultPath: safeSuggested });
      if (result.canceled || !result.filePath) {
        return { ok: false, error: 'cancelled' };
      }
      await copyFile(resolved, result.filePath);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

ipcMain.handle('desktop:pick-directory', async () => {
  const currentWorkspaceDir = await getWorkspacePickerDefaultDir();
  const dialogOptions: OpenDialogOptions = {
    properties: ['openDirectory'],
    title: 'Select Workspace Folder',
    buttonLabel: 'Use Folder',
    defaultPath: currentWorkspaceDir,
  };
  const win = getMainWindow();
  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  return {
    ok: !result.canceled,
    path: result.canceled ? null : (result.filePaths[0] ?? null),
  };
});

ipcMain.handle('voice:transcribe', async (_event, audio: ArrayBuffer | Uint8Array) => {
  return transcribeVoiceAudio(audio);
});
ipcMain.handle('voice:get-status', () => getVoiceTranscriptionStatus());
ipcMain.handle('voice:set-model', (_event, modelId: string) => setVoiceTranscriptionModel(modelId));
ipcMain.handle('voice:install-model', (_event, modelId: string) => installVoiceTranscriptionModel(modelId));

ipcMain.handle('app:get-setup-status', () => ({
  needed: appSetupNeeded,
  complete: appSetupComplete,
}));

// Returns the macOS UI language (e.g. 'he', 'ar-EG', 'en-US') as Electron sees
// it. This is the same locale that drives the system window-chrome direction,
// so it's the authoritative signal for whether the traffic-light buttons are
// mirrored to the top-right. Prefer this over `navigator.language` /
// `navigator.languages` in the renderer — those reflect the *web* preferred
// language list, not the OS UI language, and can disagree on multilingual
// systems.
ipcMain.handle('app:get-system-locale', () => app.getLocale());
ipcMain.handle('app:get-version', () => app.getVersion());

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

    // Channels/earnings are seller-only — not needed in the desktop (buyer) app.
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
      cachedCryptoConfig = null; // Invalidate cached crypto config
      invalidateOnChainEnrichmentCache();
      creditsRpcFailCount = 0; // Reset backoff so new config is tried immediately
      // Restart payments portal if running so it picks up new contract/chain config
      void stopPaymentsPortal().catch(() => {});
      return { ok: true, data: { config: merged }, error: null, status: 200 };
    } catch (err) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null };
    }
  },
);

// ── Credits / Deposits Balance ──

type CreditsInfo = {
  evmAddress: string | null;
  operatorAddress: string | null;
  balanceUsdc: string;
  reservedUsdc: string;
  availableUsdc: string;
  creditLimitUsdc: string;
};

// Use shared formatUsdc from @antseed/node
const formatUsdc6 = formatUsdc;

let cachedCreditsInfo: CreditsInfo | null = null;

// Cached crypto config — invalidated on config update. Uses protocol defaults
// from resolveChainConfig with optional user overrides from config.json.
let cachedCryptoConfig: { rpcUrl: string; fallbackRpcUrls?: string[]; depositsAddress: string; channelsAddress: string; usdcAddress: string; chainId: number } | null = null;

async function loadCachedCryptoConfig(): Promise<typeof cachedCryptoConfig> {
  if (cachedCryptoConfig) return cachedCryptoConfig;
  let overrides: Record<string, unknown> = {};
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const payments = asRecord(config.payments);
    overrides = asRecord(payments.crypto);
  } catch {
    // No config — no crypto config available
  }
  // Resolve chain config from the selected chain ID (default: base-mainnet).
  // All contract addresses come from the preset in chain-config.ts.
  const selectedChain = asString(overrides.chainId as string, '') || 'base-mainnet';
  const userRpcUrl = asString(overrides.rpcUrl as string, '');
  const cc = resolveChainConfig({ chainId: selectedChain, ...(userRpcUrl ? { rpcUrl: userRpcUrl } : {}) });
  cachedCryptoConfig = { rpcUrl: cc.rpcUrl, ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}), depositsAddress: cc.depositsContractAddress, channelsAddress: cc.channelsContractAddress, usdcAddress: cc.usdcContractAddress, chainId: cc.evmChainId };
  return cachedCryptoConfig;
}

let creditsRpcFailCount = 0;
let creditsRpcLastFailAt = 0;
const CREDITS_RPC_BACKOFF_THRESHOLD = 3;
const CREDITS_RPC_RETRY_COOLDOWN_MS = 60_000;

async function refreshCreditsInfo(): Promise<CreditsInfo> {
  const identity = getSecureIdentity();
  if (!identity) {
    return { evmAddress: null, operatorAddress: null, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', creditLimitUsdc: '0' };
  }

  const evmAddress = identity.wallet.address;
  const cc = await loadCachedCryptoConfig();
  if (!cc) {
    return { evmAddress, operatorAddress: null, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', creditLimitUsdc: '0' };
  }

  // Back off after repeated RPC failures; retry after cooldown so transient
  // outages don't permanently disable balance display for the session.
  if (creditsRpcFailCount >= CREDITS_RPC_BACKOFF_THRESHOLD) {
    if (Date.now() - creditsRpcLastFailAt < CREDITS_RPC_RETRY_COOLDOWN_MS) {
      if (cachedCreditsInfo) return cachedCreditsInfo;
      return { evmAddress, operatorAddress: null, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', creditLimitUsdc: '0' };
    }
    // Cooldown elapsed — allow a retry attempt
    creditsRpcFailCount = 0;
  }

  const depositsClient = new DepositsClient({ rpcUrl: cc.rpcUrl, ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}), contractAddress: cc.depositsAddress, usdcAddress: cc.usdcAddress, ...(cc.chainId ? { evmChainId: cc.chainId } : {}) });

  try {
    const [balance, creditLimit, operatorAddress] = await Promise.all([
      depositsClient.getBuyerBalance(evmAddress),
      depositsClient.getBuyerCreditLimit(evmAddress),
      (async (): Promise<string | null> => {
        try {
          const addr = await depositsClient.getOperator(evmAddress);
          return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
        } catch { return null; }
      })(),
    ]);
    creditsRpcFailCount = 0;

    const info: CreditsInfo = {
      evmAddress,
      operatorAddress,
      balanceUsdc: formatUsdc6(balance.available + balance.reserved),
      reservedUsdc: formatUsdc6(balance.reserved),
      availableUsdc: formatUsdc6(balance.available),
      creditLimitUsdc: formatUsdc6(creditLimit),
    };
    cachedCreditsInfo = info;
    return info;
  } catch (err) {
    creditsRpcFailCount++;
    creditsRpcLastFailAt = Date.now();
    if (creditsRpcFailCount <= 1) {
      try { console.warn('[credits] Deposits RPC unavailable:', err instanceof Error ? err.message : String(err)); }
      catch { /* EPIPE — ignore */ }
    }
    if (cachedCreditsInfo) return cachedCreditsInfo;
    return { evmAddress, operatorAddress: null, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', creditLimitUsdc: '0' };
  }
}

ipcMain.handle('credits:get-info', async (): Promise<{ ok: boolean; data: CreditsInfo | null; error: string | null }> => {
  try {
    await ensureSecureIdentity();
    const info = await refreshCreditsInfo();
    return { ok: true, data: info, error: null };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
});

// Max spending per session: $5 USDC = 5,000,000 base units. Main process enforces
// this cap to prevent a compromised renderer from signing unbounded authorizations.
const MAX_SPENDING_AUTH_BASE_UNITS = 5_000_000n;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

ipcMain.handle('payments:sign-spending-auth', async (_event, params: {
  channelId: string;
  cumulativeAmountBaseUnits: string;
  metadataHash: string;
}) => {
  try {
    // Validate renderer-supplied parameters at the trust boundary
    if (!BYTES32_RE.test(params.channelId)) {
      return { ok: false, error: 'Invalid channel ID format' };
    }
    const cumulativeAmount = BigInt(params.cumulativeAmountBaseUnits);
    if (cumulativeAmount <= 0n || cumulativeAmount > MAX_SPENDING_AUTH_BASE_UNITS) {
      return { ok: false, error: `cumulativeAmount exceeds cap (${MAX_SPENDING_AUTH_BASE_UNITS} base units)` };
    }
    if (!BYTES32_RE.test(params.metadataHash)) {
      return { ok: false, error: 'Invalid metadataHash format' };
    }

    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    if (!identity) {
      return { ok: false, error: 'Identity not available' };
    }

    const cc = await loadCachedCryptoConfig();
    if (!cc) {
      return { ok: false, error: 'No channels contract configured' };
    }

    const wallet = identity.wallet;

    // Sign SpendingAuth (AntSeed Channels domain)
    const channelsDomain = makeChannelsDomain(cc.chainId, cc.channelsAddress);
    const spendingAuthSig = await signSpendingAuth(wallet, channelsDomain, {
      channelId: params.channelId,
      cumulativeAmount,
      metadataHash: params.metadataHash,
    });

    const buyerEvmAddress = identity.wallet.address;

    return {
      ok: true,
      data: {
        spendingAuthSig,
        buyerEvmAddress,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('payments:get-peer-info', async (_event, peerId: string) => {
  try {
    if (typeof peerId !== 'string' || peerId.trim().length === 0) {
      return { ok: false, error: 'Invalid peerId' };
    }
    await refreshPeerCache();
    const peer = lookupPeer(peerId.trim());
    if (!peer) {
      return { ok: false, error: 'Peer not found' };
    }

    return {
      ok: true,
      data: {
        peerId: peer.peerId,
        displayName: peer.displayName ?? null,
        reputation: peer.reputation ?? 0,
        onChainChannelCount: (peer as Record<string, unknown>).onChainChannelCount ?? null,
        onChainGhostCount: (peer as Record<string, unknown>).onChainGhostCount ?? null,
        evmAddress: peer.peerId ? peerIdToAddress(peer.peerId) : null,
        timestamp: (peer as Record<string, unknown>).timestamp ?? null,
        providers: peer.providers ?? [],
        services: peer.services ?? [],
      },
    };
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
  try {
    await requestBuyerPeerRefresh();
    await refreshPeerCache();
    const snapshot = getNetworkSnapshot();
    return { ok: snapshot.ok, data: snapshot, error: snapshot.error, status: 200 };
  } catch (err) {
    await refreshPeerCache();
    const snapshot = getNetworkSnapshot();
    return {
      ok: false,
      data: snapshot,
      error: err instanceof Error ? err.message : String(err),
      status: null,
    };
  }
});

ipcMain.handle('system-proxy:list-profiles', () => {
  return SYSTEM_PROXY_PROFILES.map((profile) => ({
    name: profile.name,
    displayName: profile.label,
    kind: profile.kind,
    method: profile.method,
    domains: profile.domains,
    appAction: profile.appAction,
    openUrl: profile.openUrl,
    toolName: profile.toolName,
    canRestart: Boolean(profile.restartAppName),
  }));
});

ipcMain.handle('system-proxy:start', async (_event, opts: { peerId: string; port?: number; profiles?: string[]; defaultModel?: string; servedModels?: string[]; toolRoutes?: Record<string, { peerId: string; model: string }>; profileSwitch?: boolean }) => {
  try {
    return { ok: true, state: await startSystemProxyRuntime(opts) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('system-proxy:stop', async () => {
  try {
    return { ok: true, state: await stopSystemProxyRuntime(true) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('system-proxy:get-state', () => {
  return getSystemProxyProcessState();
});

ipcMain.handle('system-proxy:install-ca', async () => {
  try {
    const dataDir = resolveConnectDataDir();
    const result = await processManager.runCliCommand(['--data-dir', dataDir, 'system-proxy', 'install-ca']);
    lastSystemProxySetupAt = Date.now();
    const warning = stripAnsi(result.stdout)
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith('Warning:'))
      ?.replace(/^Warning:\s*/, '')
      .trim();
    return { ok: true, ...(warning ? { warning } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('system-proxy:test-gui', async (_event, opts?: { port?: number }): Promise<SystemProxyGuiTestResult> => {
  const port = opts?.port ?? DEFAULT_SYSTEM_PROXY_PORT;
  const targetApp = restartTargetProcessInfo();
  const proxyConfigured = process.platform === 'darwin'
    ? getSystemProxyServices(port).length > 0
    : true;
  const proxyReachable = await canConnectToLocalPort(port);
  const needsAppRestartByStartTime = Boolean(
    targetApp.running
    && lastSystemProxySetupAt
    && (!targetApp.startedAt || targetApp.startedAt < lastSystemProxySetupAt),
  );

  if (!proxyReachable) {
    return {
      ok: false,
      proxyConfigured,
      proxyReachable,
      guiTrustOk: false,
      appRunning: targetApp.running,
      needsAppRestart: needsAppRestartByStartTime,
      appPid: targetApp.pid,
      error: `System Proxy is not listening on 127.0.0.1:${port}.`,
    };
  }

  if (!proxyConfigured) {
    return {
      ok: false,
      proxyConfigured,
      proxyReachable,
      guiTrustOk: false,
      appRunning: targetApp.running,
      needsAppRestart: needsAppRestartByStartTime,
      appPid: targetApp.pid,
      error: 'macOS HTTPS proxy is not pointing at System Proxy.',
    };
  }

  const probe = await runGuiSystemProxyTrustProbe();
  const needsAppRestart = !probe.ok && (
    needsAppRestartByStartTime
    || (targetApp.running && isCertificateTrustError(probe.error ?? ''))
  );
  return {
    ok: probe.ok,
    proxyConfigured,
    proxyReachable,
    guiTrustOk: probe.ok,
    appRunning: targetApp.running,
    needsAppRestart,
    appPid: targetApp.pid,
    statusCode: probe.statusCode,
    error: probe.error,
  };
});

ipcMain.handle('system-proxy:restart-app', async (_event, opts: { app: string }) => {
  const profileName = typeof opts?.app === 'string' ? opts.app : '';
  const profile = SYSTEM_PROXY_PROFILES.find((item) => item.name === profileName);
  const appName = profile?.restartAppName;
  if (!appName) {
    return { ok: false, error: `No restart target configured for ${profileName || 'this profile'}.` };
  }
  return restartMacApp(appName);
});

ipcMain.handle('system-proxy:ca-exists', () => {
  const dataDir = resolveConnectDataDir();
  return existsSync(path.join(dataDir, 'system-proxy', 'ca.crt'))
    && existsSync(path.join(dataDir, 'system-proxy', 'ca.key'));
});

ipcMain.handle('system-proxy:add-to-shell', async (_event, opts?: { port?: number }) => {
  const { readFile, appendFile, writeFile } = await import('node:fs/promises');
  const { join: pjoin } = path;
  const home = homedir();
  const port = opts?.port ?? DEFAULT_SYSTEM_PROXY_PORT;
  const caPath = systemProxyCaPath();
  const hookFile = systemProxyHookPath();
  const marker = '# AntSeed System Proxy';
  const block = [
    '',
    marker,
    `export HTTPS_PROXY=http://localhost:${port}`,
    `export NODE_EXTRA_CA_CERTS="${caPath}"`,
    `export NODE_OPTIONS="--require ${hookFile}"`,
    '# End AntSeed System Proxy',
    '',
  ].join('\n');

  const candidates = [
    pjoin(home, '.zshrc'),
    pjoin(home, '.bash_profile'),
    pjoin(home, '.bashrc'),
  ];
  const added: string[] = [];

  for (const profilePath of candidates) {
    let existing = '';
    try { existing = await readFile(profilePath, 'utf8'); } catch { continue; }
    // Remove any prior block before appending the current one
    const cleaned = removeSystemProxyShellBlock(existing);
    if (cleaned !== existing) {
      await writeFile(profilePath, cleaned + block, 'utf8');
    } else {
      await appendFile(profilePath, block, 'utf8');
    }
    added.push(profilePath);
  }

  // If none existed, create .zshrc
  if (added.length === 0) {
    const zshrc = pjoin(home, '.zshrc');
    let existing = '';
    try { existing = await readFile(zshrc, 'utf8'); } catch { /* doesn't exist */ }
    const cleaned = removeSystemProxyShellBlock(existing);
    await writeFile(zshrc, cleaned + block, 'utf8');
    added.push(zshrc);
  }

  return { ok: true, added };
});

ipcMain.handle('system-proxy:remove-from-shell', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join: pjoin } = path;
  const home = homedir();

  const candidates = [
    pjoin(home, '.zshrc'),
    pjoin(home, '.bash_profile'),
    pjoin(home, '.bashrc'),
  ];
  const removed: string[] = [];

  for (const profilePath of candidates) {
    let existing = '';
    try { existing = await readFile(profilePath, 'utf8'); } catch { continue; }
    const cleaned = removeSystemProxyShellBlock(existing);
    if (cleaned !== existing) {
      await writeFile(profilePath, cleaned, 'utf8');
      removed.push(profilePath);
    }
  }

  return { ok: true, removed };
});

app.whenReady().then(async () => {
  installAttachmentProtocol();
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
  // Must complete before creating the window — the renderer auto-starts the
  // buyer runtime which needs config.json to find the router plugin.
  await ensureConfig(ACTIVE_CONFIG_PATH).catch(() => {});
  loadPersistedSystemProxyState();

  const showMainWindow = () => {
    const existingWindow = getMainWindow();
    if (existingWindow) {
      existingWindow.show();
      existingWindow.focus();
      return;
    }
    createWindow({ appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl });
  };

  showMainWindow();
  createDesktopTray({
    appName: APP_NAME,
    iconPath: TRAY_ICON_PATH,
    onShow: showMainWindow,
    buildMenu: () => buildSystemProxyTrayMenu(showMainWindow),
  });
  refreshTrayMenu();

  const restoredProfiles = Array.isArray(activeSystemProxyState?.['activeProfileNames'])
    ? activeSystemProxyState['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const restoredProxyProfiles = restoredProfiles.filter((name) => !isConfigPatchProfileName(name));
  if (restoredProxyProfiles.length > 0 && typeof activeSystemProxyState?.['peerId'] === 'string') {
    void startSystemProxyRuntime({
      peerId: activeSystemProxyState['peerId'],
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: restoredProfiles,
      defaultModel: typeof activeSystemProxyState['defaultModel'] === 'string' ? activeSystemProxyState['defaultModel'] : undefined,
      servedModels: [],
      profileSwitch: true,
    }).catch((err) => {
      appendLog('system-proxy', 'system', `System Proxy auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Pre-load identity from encrypted store so it's ready before the first CLI spawn.
  void ensureSecureIdentity().catch(() => {
    // Failure is logged inside ensureSecureIdentity; CLI falls back to file-based identity.
  });

  // Payments portal starts lazily on first open (via payments:open-portal IPC)

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

  // Auto-update: check for updates silently on launch and every 30 minutes.
  // If an in-flight download stops emitting progress events for a couple of
  // minutes (network drop, stuck CDN connection, etc.) we re-trigger the
  // update check so electron-updater resumes/restarts the download instead
  // of sitting idle forever.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
  const DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1000;
  const DOWNLOAD_STALL_POLL_MS = 30 * 1000;

  let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
  let downloadStallInterval: ReturnType<typeof setInterval> | null = null;
  let lastDownloadProgressAt: number | null = null;
  let lastDownloadPercent = 0;

  const clearStallWatchdog = () => {
    if (downloadStallInterval) {
      clearInterval(downloadStallInterval);
      downloadStallInterval = null;
    }
    lastDownloadProgressAt = null;
    lastDownloadPercent = 0;
  };

  const startStallWatchdog = () => {
    clearStallWatchdog();
    lastDownloadProgressAt = Date.now();
    downloadStallInterval = setInterval(() => {
      if (!pendingUpdateVersion || lastDownloadProgressAt === null) return;
      // Once bytes are done electron-updater still spends time verifying the
      // file (sha512 / code-sign) and emits no progress — don't treat that as
      // a stall, just wait for update-downloaded.
      if (lastDownloadPercent >= 100) return;
      const idleMs = Date.now() - lastDownloadProgressAt;
      if (idleMs < DOWNLOAD_STALL_TIMEOUT_MS) return;
      console.warn(`[auto-update] download stalled (${Math.round(idleMs / 1000)}s with no progress) — retrying`);
      clearStallWatchdog();
      pendingUpdateVersion = null;
      void autoUpdater.checkForUpdates().catch((err) => {
        console.error('[auto-update] stall-retry failed:', err?.message ?? err);
      });
    }, DOWNLOAD_STALL_POLL_MS);
  };

  let pendingUpdateVersion: string | null = null;
  autoUpdater.on('update-available', (info) => {
    pendingUpdateVersion = info.version;
    startStallWatchdog();
    getMainWindow()?.webContents.send('app:update-status', { status: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (!pendingUpdateVersion) return;
    lastDownloadProgressAt = Date.now();
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
    lastDownloadPercent = percent;
    getMainWindow()?.webContents.send('app:update-status', {
      status: 'downloading',
      version: pendingUpdateVersion,
      percent,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdateVersion = null;
    clearStallWatchdog();
    getMainWindow()?.webContents.send('app:update-status', { status: 'ready', version: info.version });
    if (updateCheckInterval) {
      clearInterval(updateCheckInterval);
      updateCheckInterval = null;
    }
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error:', err?.message ?? err);
    clearStallWatchdog();
    pendingUpdateVersion = null;
  });

  void autoUpdater.checkForUpdates().catch(() => {});

  updateCheckInterval = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);

  ipcMain.handle('app:install-update', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void stopManagedRuntimes().finally(() => app.quit());
  }
});

let isQuitting = false;

app.on('before-quit', (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  isQuitting = true;

  void Promise.all([stopManagedRuntimes(), stopPaymentsPortal()])
    .finally(() => {
      app.quit();
    });
});

// Ensure child processes are cleaned up if the main process receives a terminal
// stop signal before before-quit fires.
process.on('SIGINT', () => {
  void Promise.all([stopManagedRuntimes(), stopPaymentsPortal()]).finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void Promise.all([stopManagedRuntimes(), stopPaymentsPortal()]).finally(() => process.exit(0));
});

// Suppress EPIPE errors from console.error/console.warn when the dev terminal
// pipe is closed (e.g. Ctrl+C in the terminal while Electron is still running).
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});
