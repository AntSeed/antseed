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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
  type StartOptions,
  resolveConnectDataDir,
} from './process-manager.js';
import { registerPiChatHandlers, invalidateOnChainEnrichmentCache } from './pi-chat-engine.js';
import { ensureSecureIdentity, secureIdentityEnv, getSecureIdentity } from './identity.js';
import { ANTSTokenClient, ChannelsClient, DepositsClient, DepositRelayClient, EmissionsClient, signSpendingAuth, makeChannelsDomain, makeUsdcDomain, buildReceiveAuthorization, peerRelaysSweeps, resolveChainConfig, formatUsdc, peerIdToAddress } from '@antseed/node';
import type { SweepRequestPayload, SweepReceiptPayload } from '@antseed/node';
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
import {
  createWindow,
  createApplicationMenu,
  getMainWindow,
  applyWindowView,
  openFloatWindow,
  closeFloatWindow,
  getFloatWindow,
  setFloatWindowCompact,
  getFloatWindowCompact,
} from './window.js';
import { createDesktopTray, updateDesktopTray } from './tray.js';
import { ensureConfig, readConfig, mergeConfig, readNodeStatus } from './config-io.js';
import { registerAttachmentScheme, installAttachmentProtocol } from './attachment-protocol.js';
import { resolveAttachmentPath } from './attachment-store.js';
import { getWorkspacePickerDefaultDir } from './chat-workspace.js';
import { getOpenRouterReferencePrices } from './openrouter-catalog.js';
import { applyConfigPatch, removeConfigPatch, type ConfigPatchDef } from './system-proxy-config-patch.js';
import { mergeWithDefaultAppProfiles } from './default-apps.js';
import {
  customAppName,
  customAppToCliProfile,
  deriveCustomAppTarget,
  fetchCustomAppSiteMetadata,
  loadCustomApps,
  saveCustomApps,
  type CustomAppRecord,
} from './custom-apps.js';
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
const SYSTEM_PROXY_ENV_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS'] as const;

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

type DesktopSystemProxyProfileMetadata = {
  readonly displayLabel?: string;
  readonly methodLabel?: string;
  readonly appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app';
  readonly openUrl?: string;
  readonly toolName?: string;
  readonly restartAppName?: string;
};

type DesktopBuyerUsageTotals = {
  totalRequests: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  uniqueSellers: number;
  activeChannels: number;
};

type DesktopPaymentChannelSummary = {
  channelId: string;
  peerId: string;
  seller: string;
  reserveMax: string;
  cumulativeSigned: string;
  reservedAt: number;
  status: string;
  requestCount: number;
  inputTokens: string;
  outputTokens: string;
};

type DesktopRewardsSummary = {
  available: boolean;
  pendingAnts: string;
  currentEpoch: number | null;
  transfersEnabled: boolean;
  error: string | null;
};

const { profiles: SYSTEM_PROXY_PROFILES, raw: SYSTEM_PROXY_PROFILES_RAW } = loadDesktopSystemProxyProfiles();

function loadDesktopSystemProxyProfiles(env: NodeJS.ProcessEnv = process.env): {
  profiles: readonly DesktopSystemProxyProfile[];
  raw: readonly unknown[];
} {
  const envJson = env[SYSTEM_PROXY_PROFILES_JSON_ENV]?.trim();
  const envFile = env[SYSTEM_PROXY_PROFILES_FILE_ENV]?.trim();
  const packagedFile = packagedSystemProxyProfilesPath();
  const raw = envJson
    || (envFile ? readFileSync(envFile, 'utf8') : '')
    || (packagedFile ? readFileSync(packagedFile, 'utf8') : '');
  const parsed = raw ? JSON.parse(raw) as unknown : [];
  if (!Array.isArray(parsed)) {
    throw new Error(`${SYSTEM_PROXY_PROFILES_JSON_ENV} / ${SYSTEM_PROXY_PROFILES_FILE_ENV} must define a JSON array`);
  }
  const merged = mergeWithDefaultAppProfiles(parsed);
  return {
    profiles: merged.map((profile, index) => normalizeDesktopSystemProxyProfile(profile, index)),
    raw: merged,
  };
}

function loadCustomAppRecords(): CustomAppRecord[] {
  return loadCustomApps(resolveConnectDataDir());
}

function customAppDesktopProfile(record: CustomAppRecord): DesktopSystemProxyProfile {
  return {
    name: record.name,
    label: record.displayName,
    kind: 'proxy',
    method: 'HTTPS proxy',
    domains: [record.host],
  };
}

/** Packaged profiles plus the user's custom apps, in display order. */
function allSystemProxyProfiles(): DesktopSystemProxyProfile[] {
  return [...SYSTEM_PROXY_PROFILES, ...loadCustomAppRecords().map(customAppDesktopProfile)];
}

function packagedSystemProxyProfilesPath(): string | null {
  if (!app.isPackaged || typeof process.resourcesPath !== 'string') return null;
  const filePath = path.join(process.resourcesPath, PACKAGED_SYSTEM_PROXY_PROFILES_RELATIVE);
  return existsSync(filePath) ? filePath : null;
}

function systemProxyProfilesEnv(): Record<string, string> {
  // The CLI child reads profiles once at startup, so hand it a merged file
  // combining the built-in defaults, the packaged/env profiles, and the
  // user's custom apps.
  const merged = [...SYSTEM_PROXY_PROFILES_RAW, ...loadCustomAppRecords().map(customAppToCliProfile)];
  const filePath = path.join(systemProxyDataDir(), 'profiles.merged.json');
  mkdirSync(systemProxyDataDir(), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { [SYSTEM_PROXY_PROFILES_FILE_ENV]: filePath };
}

function normalizeDesktopSystemProxyProfile(value: unknown, index: number): DesktopSystemProxyProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`System Proxy profile at index ${index} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const name = readRequiredString(raw, 'name', index);
  const metadata = readProfileMetadata(raw['metadata']);
  const label = readString(raw, 'displayName') ?? readString(raw, 'label') ?? metadata?.displayLabel ?? `Tool ${index + 1}`;
  const kind = raw['kind'] === 'config-patch' ? 'config-patch' : 'proxy';
  const configPatch = readConfigPatch(raw['configPatch'], name);
  const appAction = readAppAction(raw['appAction']) ?? metadata?.appAction;
  const openUrl = readString(raw, 'openUrl') ?? metadata?.openUrl;
  const toolName = readString(raw, 'toolName') ?? metadata?.toolName;
  const restartAppName = readString(raw, 'restartAppName') ?? metadata?.restartAppName;
  return {
    name,
    label,
    kind,
    method: readString(raw, 'method') ?? metadata?.methodLabel ?? (kind === 'config-patch' ? 'Config' : 'Proxy'),
    domains: readStringArray(raw['domains']),
    ...(appAction ? { appAction } : {}),
    ...(openUrl ? { openUrl } : {}),
    ...(toolName ? { toolName } : {}),
    ...(restartAppName ? { restartAppName } : {}),
    ...(configPatch ? { configPatch } : {}),
  };
}

function readProfileMetadata(value: unknown): DesktopSystemProxyProfileMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const appAction = readAppAction(raw['appAction']);
  const metadata: DesktopSystemProxyProfileMetadata = {
    ...(readString(raw, 'displayLabel') ? { displayLabel: readString(raw, 'displayLabel') } : {}),
    ...(readString(raw, 'methodLabel') ? { methodLabel: readString(raw, 'methodLabel') } : {}),
    ...(appAction ? { appAction } : {}),
    ...(readString(raw, 'openUrl') ? { openUrl: readString(raw, 'openUrl') } : {}),
    ...(readString(raw, 'toolName') ? { toolName: readString(raw, 'toolName') } : {}),
    ...(readString(raw, 'restartAppName') ? { restartAppName: readString(raw, 'restartAppName') } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readConfigPatch(value: unknown, profileName: string): ConfigPatchDef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`configPatch for ${profileName} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const configPath = readRequiredString(raw, 'configPath', profileName);
  const providerKey = readRequiredString(raw, 'providerKey', profileName);
  const baseURL = readRequiredString(raw, 'baseURL', profileName);
  const format = readString(raw, 'format');
  if (format === 'codex') {
    return {
      format: 'codex',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
    };
  }
  if (format === 'pi') {
    const api = raw['api'];
    return {
      format: 'pi',
      configPath,
      settingsPath: readRequiredString(raw, 'settingsPath', profileName),
      providerKey,
      baseURL,
      api: api === 'openai-responses' || api === 'anthropic-messages' ? api : 'openai-completions',
    };
  }
  return {
    format: 'opencode',
    configPath,
    providerKey,
    npm: readRequiredString(raw, 'npm', profileName),
    providerName: readRequiredString(raw, 'providerName', profileName),
    baseURL,
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
  process.env['HTTPS_PROXY'] = `http://localhost:${port}`;
  process.env['NODE_EXTRA_CA_CERTS'] = caPath;
  process.env['NODE_OPTIONS'] = `--require ${hookFile}`;
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
      // Ownership guard: only disable the proxy if it points at the AntSeed proxy.
      const out = execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyServer',
      ], { encoding: 'utf8' });
      if (!out.includes(`127.0.0.1:${port}`) && !out.includes(`localhost:${port}`)) {
        return;
      }
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
  clearSystemProxyNodeEnv(port);
  await restoreOsSystemProxy(port);
  await clearSystemProxyRuntimeFiles();
  await removeSystemProxyFromShellProfiles();
}

async function clearSystemProxyTransportSettings(port = DEFAULT_SYSTEM_PROXY_PORT): Promise<void> {
  clearSystemProxyNodeEnv(port);
  await restoreOsSystemProxy(port);
  await removeSystemProxyFromShellProfiles();
}

async function stopManagedRuntimes(): Promise<void> {
  try {
    await processManager.stopAll();
  } finally {
    await clearSystemProxySettings();
    removeAllConfigPatches();
    traySystemProxyProfiles = new Set();
  }
}

function removeSystemProxyShellBlock(content: string): string {
  // Remove the block between the start/end markers (inclusive), plus surrounding blank lines
  return content
    .replace(/\n*# AntSeed System Proxy\n[\s\S]*?# End AntSeed System Proxy\n*/gi, '\n')
    .replace(/\n*# AntSeed intercept proxy\n(?:export (?:HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS)=.*\n)+/gi, '\n')
    .replace(/\n*# AntSeed CLI shell params\n(?:export (?:HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS)=.*\n)+/gi, '\n');
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

function readWindowsUserEnvValue(varName: string): string {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', varName], { encoding: 'utf8' });
    const match = out.match(new RegExp(`${varName}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`, 'i'));
    return match?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function readDarwinUserEnvValue(varName: string): string {
  try {
    return execFileSync('launchctl', ['getenv', varName], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isSystemProxyEnvValue(varName: string, value: string, port: number): boolean {
  const dataDir = systemProxyDataDir();
  const caPath = systemProxyCaPath();
  const hookFile = systemProxyHookPath();
  const proxyPattern = new RegExp(`^(?:https?://)?(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::${port})/?$`, 'i');
  if (varName === 'HTTPS_PROXY' || varName === 'HTTP_PROXY' || varName === 'ALL_PROXY') {
    return proxyPattern.test(value.trim());
  }
  if (varName === 'NODE_EXTRA_CA_CERTS') {
    return value === caPath || value.startsWith(`${dataDir}${path.sep}`);
  }
  if (varName === 'NODE_OPTIONS') {
    return value.includes(hookFile) || value.includes(`${dataDir}${path.sep}node-proxy-hook.cjs`);
  }
  return false;
}

function clearSystemProxyProcessEnv(port = DEFAULT_SYSTEM_PROXY_PORT): void {
  for (const varName of SYSTEM_PROXY_ENV_VARS) {
    const current = process.env[varName];
    if (!current || !isSystemProxyEnvValue(varName, current, port)) continue;
    delete process.env[varName];
  }
}

function clearSystemProxyNodeEnv(port = DEFAULT_SYSTEM_PROXY_PORT): void {
  clearSystemProxyProcessEnv(port);
  if (process.platform === 'darwin') {
    for (const varName of SYSTEM_PROXY_ENV_VARS) {
      const current = readDarwinUserEnvValue(varName);
      if (!current || !isSystemProxyEnvValue(varName, current, port)) continue;
      try { execFileSync('launchctl', ['unsetenv', varName], { stdio: 'pipe' }); } catch { /* best-effort */ }
    }
  } else if (process.platform === 'win32') {
    // Ownership guard: only clear vars whose current value references the
    // AntSeed proxy or its data dir — leave unrelated user values alone.
    for (const varName of SYSTEM_PROXY_ENV_VARS) {
      const current = readWindowsUserEnvValue(varName);
      if (!current || !isSystemProxyEnvValue(varName, current, port)) continue;
      try { execFileSync('setx', [varName, ''], { stdio: 'pipe' }); } catch { /* best-effort */ }
    }
  }
}

const isDev = Boolean(process.env['VITE_DEV_SERVER_URL']);
const rendererUrl = process.env['VITE_DEV_SERVER_URL'] ?? `file://${path.join(__dirname, '../renderer/index.html')}`;
const APP_NAME = 'AntStation Desktop';
const DESKTOP_DEBUG_ENV = 'ANTSEED_DESKTOP_DEBUG';
const DESKTOP_DEBUG_FLAGS = new Set(['--debug-runtime', '--desktop-debug']);

type UpdateStatus =
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'installing'; version: string | null }
  | { status: 'error'; version: string | null; message: string; details: string; hint?: string };

type InstallUpdateResult =
  | { ok: true }
  | { ok: false; error: string; details: string; hint?: string };

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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Unknown updater error';
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message || String(error);
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getMacUpdateInstallHint(): string | undefined {
  if (process.platform !== 'darwin') return undefined;

  const executablePath = process.execPath;
  if (executablePath.includes('/AppTranslocation/')) {
    return 'Quit AntSeed, move it to Applications, reopen, and try again.';
  }
  if (executablePath.startsWith('/Volumes/')) {
    return 'Quit AntSeed, move it from the disk image to Applications, reopen, and try again.';
  }
  if (executablePath.includes('.app/') && !executablePath.startsWith('/Applications/')) {
    return 'Quit AntSeed, move it to Applications, reopen, and try again.';
  }
  return undefined;
}

let desktopDebugEnabled = isTruthyEnv(process.env[DESKTOP_DEBUG_ENV]) || hasDesktopDebugFlag(process.argv);
let isQuitting = false;
let isInstallingUpdate = false;

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
  const peer = lookupPeer(peerId);
  const services = peer?.services ?? (peerId === opts.peerId ? opts.servedModels ?? [] : []);
  const requestedModel = route?.model?.trim();
  const defaultModel = opts.defaultModel?.trim() ?? '';
  const model = route
    // Explicitly routed model is used verbatim; otherwise fall back to the
    // peer's first service, then the default model.
    ? (requestedModel || (services[0] ?? defaultModel))
    : (defaultModel && (services.length === 0 || services.includes(defaultModel))
      ? defaultModel
      : services[0] ?? defaultModel);
  return { peerId, model, services };
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
  if (proxyProfiles.length === 0) {
    await clearSystemProxyTransportSettings(port);
  }

  const buyerProxyPort = await resolveBuyerProxyPort();
  // Keep the buyer's default route on the current selection so configs that
  // carry the routed-model alias follow route changes without a rewrite.
  const defaultRoute = routeForTool(opts, '');
  await postBuyerDefaultRoute(buyerProxyPort, defaultRoute.peerId, defaultRoute.model);
  for (const name of configPatchProfiles) {
    const profile = SYSTEM_PROXY_PROFILES.find((p) => p.name === name);
    if (profile?.configPatch) {
      const route = routeForTool(opts, name);
      // Tools on the default route get the alias, so the model picked in the
      // floating pill / VPR applies to running sessions; per-app overrides
      // pin a concrete peer@model in the tool config.
      const followsDefault = route.peerId === defaultRoute.peerId && route.model === defaultRoute.model;
      applyConfigPatch(profile.configPatch, route.peerId, route.model, buyerProxyPort, route.services, followsDefault);
      appendLog('system-proxy', 'system', `${profile.label}: connected by config patch (peer=${shortTrayPeerId(route.peerId)}, model=${followsDefault ? `${route.model || 'auto'} via selection` : route.model || 'auto'})`);
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
    window.webContents.send('desktop:navigate-view', 'system-proxy');
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

/**
 * Tell the running buyer what the routed-model alias should resolve to.
 * Best-effort: the buyer also persists the route in buyer.state.json, so a
 * missed update self-heals on the next connect or route change.
 */
async function postBuyerDefaultRoute(buyerPort: number, peerId: string, model: string): Promise<void> {
  const service = model.trim();
  const peer = peerId.trim();
  if (!service || !/^(0x)?[0-9a-fA-F]{40}$/.test(peer)) return;
  try {
    await fetch(`http://127.0.0.1:${buyerPort}/_antseed/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `${peer}@${service}` }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    appendLog('system-proxy', 'system', `Default route update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    ...allSystemProxyProfiles().map((profile): MenuItemConstructorOptions => {
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

function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  win.focus();
}

async function startPaymentsPortal(): Promise<void> {
  if (paymentsServer) return;
  try {
    await ensureSecureIdentity();
    const identityHex = secureIdentityEnv().ANTSEED_IDENTITY_HEX;
    paymentsServer = await createPaymentsServer({
      port: PAYMENTS_PORT,
      identityHex,
      onPaymentCompleted: () => {
        // Closing a Chrome app-mode popup hands focus to whatever window the
        // OS picks (often another Chrome window) — pull the app back up and
        // let the renderer refresh balances/channels/rewards immediately.
        focusMainWindow();
        getMainWindow()?.webContents.send('payments:completed');
      },
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

async function stopDesktopServices(): Promise<void> {
  await Promise.all([stopManagedRuntimes(), stopPaymentsPortal()]);
}

// Slim payment pages: only actions that need an external wallet signature
// (connected-wallet deposit, withdraw, authorize-operator, channel close,
// rewards claims) leave the app — everything else renders in-app. The full
// portal dashboard is retired.
//
// Preferred surface: the user's REAL Chromium browser launched in app mode
// (`--app=<url>`) — a chromeless window (no address bar, no tabs) that runs
// in their normal profile, so extension wallets like MetaMask work. When no
// Chromium browser is installed, fall back to a sandboxed Electron popup
// (WalletConnect/QR flows only). Both close themselves after payment.
type PayPageKind = 'deposit' | 'withdraw' | 'authorize' | 'claim' | 'diem' | 'close-channel';
const PAY_PAGE_KINDS: readonly PayPageKind[] = ['deposit', 'withdraw', 'authorize', 'claim', 'diem', 'close-channel'];

async function tryOpenBrowserAppMode(url: string): Promise<boolean> {
  // The `open` package resolves browser install locations per platform —
  // apps.chrome / apps.edge are cross-platform aliases. Brave has no alias,
  // so it gets a per-platform name.
  const { apps, openApp } = await import('open');
  const brave = process.platform === 'darwin' ? 'Brave Browser'
    : process.platform === 'win32' ? 'brave'
    : 'brave-browser';
  const candidates = [apps.chrome, apps.edge, brave] as const;
  for (const name of candidates) {
    try {
      // newInstance matters on macOS: without it, a running browser is just
      // focused and the --app argument is silently ignored.
      const child = await openApp(name, { newInstance: true, arguments: [`--app=${url}`, '--window-size=480,820'] });
      const launched = await new Promise<boolean>((resolve) => {
        // macOS/Windows go through a launcher that exits immediately (code 1
        // when the browser isn't installed); on Linux the browser process
        // itself is spawned and stays alive — treat "still running" as success.
        const timer = setTimeout(() => resolve(true), 1_500);
        child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
        child.once('error', () => { clearTimeout(timer); resolve(false); });
      });
      if (launched) {
        console.log(`[payments] pay page opened in app-mode browser: ${String(name)}`);
        return true;
      }
      console.warn(`[payments] app-mode launch failed for ${String(name)} (non-zero exit)`);
    } catch (err) {
      console.warn(`[payments] app-mode launch error for ${String(name)}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return false;
}

let paymentsPopup: BrowserWindow | null = null;

function openPaymentsPopup(url: string): void {
  if (paymentsPopup && !paymentsPopup.isDestroyed()) {
    void paymentsPopup.loadURL(url);
    paymentsPopup.focus();
    return;
  }
  const parent = getMainWindow();
  paymentsPopup = new BrowserWindow({
    width: 480,
    height: 800,
    minWidth: 420,
    minHeight: 620,
    ...(parent ? { parent } : {}),
    title: 'AntSeed — Secure payment',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  paymentsPopup.setMenuBarVisibility(false);
  // Wallet deep links and explorer links leave the popup for the system
  // browser; the popup stays on the payment page only.
  paymentsPopup.webContents.setWindowOpenHandler(({ url: external }) => {
    void shell.openExternal(external);
    return { action: 'deny' };
  });
  paymentsPopup.on('closed', () => {
    paymentsPopup = null;
    focusMainWindow();
  });
  void paymentsPopup.loadURL(url);
}

ipcMain.handle('payments:open-pay-page', async (_event, opts: { kind?: PayPageKind; amountUsdc?: string; channelId?: string }) => {
  try {
    const kind: PayPageKind = opts?.kind && PAY_PAGE_KINDS.includes(opts.kind) ? opts.kind : 'deposit';
    await startPaymentsPortal();
    const token = paymentsServer ? (paymentsServer as unknown as { bearerToken?: string }).bearerToken : '';
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    params.set('page', 'pay');
    params.set('action', kind);
    const amount = Number(opts?.amountUsdc);
    if (Number.isFinite(amount) && amount > 0) params.set('amount', String(amount));
    if (kind === 'close-channel' && typeof opts?.channelId === 'string' && BYTES32_RE.test(opts.channelId)) {
      params.set('channel', opts.channelId);
    }
    const devUrl = isDev ? process.env['ANTSEED_PAYMENTS_DEV_URL']?.trim() : undefined;
    const base = devUrl || `${LOCALHOST_URL}:${PAYMENTS_PORT}`;

    // popup=app → real browser in app mode (extensions available);
    // popup=win → Electron fallback (WalletConnect/QR only).
    const appModeUrl = `${base}?${params.toString()}&popup=app`;
    if (await tryOpenBrowserAppMode(appModeUrl)) {
      return { ok: true, url: appModeUrl };
    }
    const fallbackUrl = `${base}?${params.toString()}&popup=win`;
    console.log('[payments] no app-mode browser available — using Electron popup');
    openPaymentsPopup(fallbackUrl);
    return { ok: true, url: fallbackUrl };
  } catch (err) {
    console.error('[payments] open-pay-page failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// Card payments open a hosted checkout page. USDC bought with a card is
// delivered on Base to the buyer hot wallet and credited into AntseedDeposits
// via the P2P deposit relay — same path as a direct QR transfer.
//
// Providers come from config (payments.card.providers) as HTTPS URL templates
// with {address} and optional {amount} placeholders. The default is AntSeed's
// hosted card page, which handles the Coinbase Onramp session server-side so
// the CDP secret key never ships inside the app.
type CardProvider = { id: string; label: string; url: string };

const DEFAULT_CARD_PROVIDERS: CardProvider[] = [
  { id: 'coinbase', label: 'Coinbase', url: 'https://pay.antseed.com/?address={address}&amount={amount}' },
];

// A configured empty array is respected (zero providers = card disabled);
// only a missing/invalid config falls back to the built-in default.
async function readCardProviders(): Promise<CardProvider[]> {
  let entries: unknown;
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    entries = asRecord(asRecord(config.payments).card).providers;
  } catch {
    return DEFAULT_CARD_PROVIDERS;
  }
  if (!Array.isArray(entries)) return DEFAULT_CARD_PROVIDERS;
  const providers: CardProvider[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = asString(record.id as string, '');
    const label = asString(record.label as string, '');
    const url = asString(record.url as string, '');
    if (id && label && url) providers.push({ id, label, url });
  }
  return providers;
}

ipcMain.handle('payments:card-providers', async () => {
  try {
    const providers = await readCardProviders();
    // Only id + label cross into the renderer — URLs stay in the main process.
    return { ok: true, data: providers.map(({ id, label }) => ({ id, label })) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('payments:open-card-provider', async (_event, opts?: { providerId?: string; amountUsdc?: string }) => {
  try {
    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    if (!identity) return { ok: false, error: 'Identity not available' };
    const providers = await readCardProviders();
    const provider = opts?.providerId
      ? providers.find((entry) => entry.id === opts.providerId)
      : providers[0];
    if (!provider) return { ok: false, error: 'card-not-configured' };

    const amount = Number(opts?.amountUsdc);
    const hasAmount = Number.isFinite(amount) && amount > 0;
    let template = provider.url.split('{address}').join(identity.wallet.address);
    if (hasAmount) template = template.split('{amount}').join(String(amount));
    let parsed: URL;
    try {
      parsed = new URL(template);
    } catch {
      return { ok: false, error: 'Card provider URL is invalid' };
    }
    // https only — except loopback, so a locally-run payment page can be
    // tested from the app before it is deployed.
    const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
      return { ok: false, error: 'Card provider URL must be https' };
    }
    if (!hasAmount) {
      // No amount entered — drop query params still carrying the placeholder.
      for (const [key, value] of [...parsed.searchParams.entries()]) {
        if (value.includes('{amount}')) parsed.searchParams.delete(key);
      }
    }
    const url = parsed.toString();

    if (await tryOpenBrowserAppMode(url)) {
      return { ok: true, url };
    }
    console.log('[payments] no app-mode browser available — using Electron popup');
    openPaymentsPopup(url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// Crossmint Stablecoin Onramp — in-app embedded checkout for buying USDC on
// Base with a card, delivered to the buyer hot wallet (then swept into
// deposits by the same watcher as QR/card transfers). The client-side key is
// public by design: it ships in the app and is origin-restricted in the
// Crossmint console, exactly like DEFAULT_CARD_PROVIDERS embeds AntSeed's
// hosted URL. Overridable via config.payments.crossmint.clientKey.
const DEFAULT_CROSSMINT_CLIENT_KEY = 'ck_production_ABDYKwqzx1t6ZCbkVTyWGUMQvnARXTXHMkjgQY5LS7TFy81sDDQnRez9aY3ogznqmWM4uQ7PuUzm9S4Tj7WxPdFj1Rj5BEzZJB9sSErLxC7qmKrPFPBvhqsYCvWL6wHfzWQqtekvcXUZhuFCiWHcRALx4UsZdTZ7MHb11xCesc56WizPx9o6BKtLqA9yQhcLppJX3sYngJPn7sBCT6n9sqHt';

function crossmintApiBase(clientKey: string): string {
  return clientKey.startsWith('ck_staging_') ? 'https://staging.crossmint.com' : 'https://www.crossmint.com';
}

async function readCrossmintClientKey(): Promise<string> {
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const key = asString(asRecord(asRecord(config.payments).crossmint).clientKey as string, '');
    return key || DEFAULT_CROSSMINT_CLIENT_KEY;
  } catch {
    return DEFAULT_CROSSMINT_CLIENT_KEY;
  }
}

ipcMain.handle('payments:crossmint-config', async () => {
  try {
    const clientKey = await readCrossmintClientKey();
    if (!clientKey) return { ok: true, data: null };
    return { ok: true, data: { clientKey, apiBase: crossmintApiBase(clientKey) } };
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

ipcMain.handle('openrouter:reference-prices', () => getOpenRouterReferencePrices());

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
      cachedEmissionsClient = null;
      cachedAntsTokenClient = null;
      cachedChannelsClient = null;
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
let cachedCryptoConfig: {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  depositsAddress: string;
  channelsAddress: string;
  usdcAddress: string;
  chainId: number;
  emissionsAddress?: string;
  antsTokenAddress?: string;
  depositRelayAddress?: string;
} | null = null;

// Cached on-chain clients for the rewards summary — invalidated together with
// cachedCryptoConfig on config updates.
let cachedEmissionsClient: EmissionsClient | null = null;
let cachedAntsTokenClient: ANTSTokenClient | null = null;
let cachedChannelsClient: ChannelsClient | null = null;

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
  cachedCryptoConfig = {
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    depositsAddress: cc.depositsContractAddress,
    channelsAddress: cc.channelsContractAddress,
    usdcAddress: cc.usdcContractAddress,
    chainId: cc.evmChainId,
    ...(cc.emissionsContractAddress ? { emissionsAddress: cc.emissionsContractAddress } : {}),
    ...(cc.antsTokenAddress ? { antsTokenAddress: cc.antsTokenAddress } : {}),
    ...(cc.depositRelayAddress ? { depositRelayAddress: cc.depositRelayAddress } : {}),
  };
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

// ── Incoming USDC watcher + P2P relay sweep ──
//
// While the in-app deposit panel is open, the renderer starts this watcher.
// It polls the hot wallet's USDC balance; any increase is treated as an
// incoming deposit (QR transfer or Coinbase Onramp delivery). The funds are
// then swept into AntseedDeposits gaslessly: the hot wallet signs an EIP-3009
// authorization addressed to the AntseedDepositRelay contract and the buyer
// daemon broadcasts a SweepRequest to connected peers; a permissionless
// relayer submits it on-chain and earns the contract's fixed USDC fee
// (docs/protocol/spec/09-deposit-sweep.md). The hot wallet never needs ETH.

type DepositWatchStatus = {
  phase: 'received' | 'sweeping' | 'credited' | 'error';
  amountBaseUnits?: string;
  txHash?: string;
  error?: string;
};

const DEPOSIT_WATCH_INTERVAL_MS = 4_000;
const SWEEP_AUTH_VALIDITY_SECS = 3_600;
const SWEEP_CONFIRM_TIMEOUT_MS = 120_000;
const SWEEP_POLL_INTERVAL_MS = 3_000;
// After a failed/incomplete sweep the funds stay in the wallet; retry on the
// watcher tick once this cooldown passes instead of hammering the network.
const SWEEP_RETRY_COOLDOWN_MS = 60_000;
// AntseedDeposits enforces a 1 USDC minimum first deposit (net of the fee).
const MIN_FIRST_DEPOSIT_BASE_UNITS = 1_000_000n;

let depositWatchTimer: NodeJS.Timeout | null = null;
let depositWatchBalance = 0n;
let depositSweepInFlight = false;
let depositSweepLastAttemptAt = 0;

function makeDepositsClient(cc: NonNullable<Awaited<ReturnType<typeof loadCachedCryptoConfig>>>): DepositsClient {
  return new DepositsClient({
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    contractAddress: cc.depositsAddress,
    usdcAddress: cc.usdcAddress,
    ...(cc.chainId ? { evmChainId: cc.chainId } : {}),
  });
}

function sendDepositWatchStatus(status: DepositWatchStatus): void {
  getMainWindow()?.webContents.send('deposits:watch-status', status);
}

// ─── Buyer-daemon sweep control plane ───
// The running buyer daemon already holds authenticated seller connections and
// exposes the sweep endpoints on its proxy port (a second node with the same
// identity would collide with the daemon's peerId on the network).

async function buyerDaemonFetch(pathname: string, init?: RequestInit, timeoutMs = 10_000): Promise<Response | null> {
  try {
    const port = await resolveBuyerProxyPort();
    return await fetch(`${LOCALHOST_URL}:${port}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

/** POST the signed sweep payload to the daemon. Returns the peers-sent count,
 *  or null when no daemon is listening on the proxy port. */
async function daemonBroadcastSweep(payload: SweepRequestPayload): Promise<number | null> {
  const res = await buyerDaemonFetch('/_antseed/sweep', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res) return null;
  const body = await res.json().catch(() => null) as { ok?: boolean; sent?: number; error?: string } | null;
  if (!res.ok || !body?.ok || typeof body.sent !== 'number') {
    throw new Error(`Buyer daemon rejected the sweep request: ${body?.error ?? `HTTP ${res.status}`}`);
  }
  return body.sent;
}

/** Ask the daemon to refresh discovery and eagerly connect to a few peers
 *  that announce the sweep-relay capability. */
async function daemonConnectSweepRelayers(): Promise<void> {
  await buyerDaemonFetch('/_antseed/peers/refresh', { method: 'POST' }, 30_000);
  const res = await buyerDaemonFetch('/_antseed/peers');
  const body = await res?.json().catch(() => null) as {
    peers?: Array<{ peerId: string; capabilities?: string[]; metadata?: { capabilities?: string[] } }>;
  } | null;
  const relayers = (body?.peers ?? []).filter(peerRelaysSweeps);
  await Promise.allSettled(relayers.slice(0, 4).map((p) => buyerDaemonFetch('/_antseed/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peerId: p.peerId }),
  }, 20_000)));
}

async function daemonGetSweepReceipt(nonce: string): Promise<SweepReceiptPayload | null> {
  const res = await buyerDaemonFetch(`/_antseed/sweep/${nonce}`, undefined, 3_000);
  const body = await res?.json().catch(() => null) as { receipt?: SweepReceiptPayload | null } | null;
  return body?.receipt ?? null;
}

// ─── Sweep confirmation ───
// Source of truth is on-chain: a matching SweepExecuted relay event, the
// consumed EIP-3009 authorization, or the deposits-balance increase. Relayer
// receipts only surface the txHash faster; zero receipts must be tolerated.
async function waitForSweepConfirmation(params: {
  depositsClient: DepositsClient;
  relayClient: DepositRelayClient;
  buyer: string;
  initialTotal: bigint;
  expectedNet: bigint;
  fee: bigint;
  usdcAddress: string;
  authNonce: string;
}): Promise<{ credited: bigint; txHash?: string } | null> {
  const { depositsClient, relayClient, buyer, initialTotal, expectedNet, fee, usdcAddress, authNonce } = params;
  const deadline = Date.now() + SWEEP_CONFIRM_TIMEOUT_MS;
  let txHash: string | undefined;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SWEEP_POLL_INTERVAL_MS));

    const receipt = await daemonGetSweepReceipt(authNonce).catch(() => null);
    if (receipt?.txHash) txHash = receipt.txHash;

    if (txHash) {
      const confirmation = await relayClient.getSweepConfirmation(txHash, {
        buyer,
        deposited: expectedNet,
        fee,
        authNonce,
      }).catch(() => null);
      if (confirmation) {
        return { credited: confirmation.deposited, txHash: confirmation.txHash };
      }
    }

    const authorizationUsed = await relayClient.isAuthorizationUsed(usdcAddress, buyer, authNonce).catch(() => false);
    if (authorizationUsed) {
      return { credited: expectedNet, ...(txHash ? { txHash } : {}) };
    }

    const current = await depositsClient.getBuyerBalance(buyer).catch(() => null);
    if (current && current.available + current.reserved >= initialTotal + expectedNet) {
      return { credited: current.available + current.reserved - initialTotal, ...(txHash ? { txHash } : {}) };
    }
  }
  return null;
}

async function sweepIncomingUsdc(client: DepositsClient, buyer: string): Promise<void> {
  if (depositSweepInFlight) return;
  depositSweepInFlight = true;
  depositSweepLastAttemptAt = Date.now();
  try {
    const identity = getSecureIdentity();
    const cc = await loadCachedCryptoConfig();
    if (!identity || !cc) return;
    if (!cc.depositRelayAddress) {
      sendDepositWatchStatus({
        phase: 'error',
        error: 'Automatic deposit is not available on this chain yet. Your USDC is safe in the wallet.',
      });
      return;
    }
    const relayClient = new DepositRelayClient({
      rpcUrl: cc.rpcUrl,
      ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
      contractAddress: cc.depositRelayAddress,
      evmChainId: cc.chainId,
    });

    const [usdcBalance, deposits, creditLimit, fee] = await Promise.all([
      client.getUSDCBalance(buyer),
      client.getBuyerBalance(buyer),
      client.getBuyerCreditLimit(buyer),
      relayClient.fee(),
    ]);

    const depositsBalance = deposits.available + deposits.reserved;
    // Below the sweepable minimum (fee, plus the contract's 1 USDC first-
    // deposit floor) — keep waiting; more USDC may still be on the way.
    const minRequired = depositsBalance === 0n ? MIN_FIRST_DEPOSIT_BASE_UNITS + fee : fee + 1n;
    if (usdcBalance < minRequired) return;

    // Deposits caps the credited balance at the buyer's credit limit; a net
    // amount past it would revert the whole sweep, so clamp and leave the
    // rest in the wallet for a later sweep.
    const headroom = creditLimit > depositsBalance ? creditLimit - depositsBalance : 0n;
    if (headroom === 0n) {
      sendDepositWatchStatus({
        phase: 'error',
        error: `Your credits are at the account limit (${formatUsdc(creditLimit)} USDC). Spend or withdraw before depositing more.`,
      });
      return;
    }
    let amount = usdcBalance;
    if (amount - fee > headroom) amount = headroom + fee;

    sendDepositWatchStatus({ phase: 'sweeping', amountBaseUnits: amount.toString() });

    // A wrong USDC domain (name/version differ per deployment) would produce
    // signatures the token silently rejects — refuse to sign.
    const usdcDomain = makeUsdcDomain(cc.chainId, cc.usdcAddress);
    const domainOk = await relayClient.verifyUsdcDomain(cc.usdcAddress, usdcDomain);
    if (!domainOk) {
      throw new Error('USDC EIP-712 domain mismatch — refusing to sign the sweep authorization.');
    }

    // The single EIP-3009 signature, addressed to the relay contract, is the
    // consent to its immutable fixed FEE — no second signature.
    const nowSecs = Math.floor(Date.now() / 1000);
    const validAfter = nowSecs - 60;
    const validBefore = nowSecs + SWEEP_AUTH_VALIDITY_SECS;
    const { message, signature: sig3009 } = await buildReceiveAuthorization(identity.wallet, usdcDomain, {
      to: cc.depositRelayAddress,
      value: amount,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
    });

    const payload: SweepRequestPayload = {
      version: 1,
      evmChainId: cc.chainId,
      relayAddress: cc.depositRelayAddress,
      from: buyer,
      amount: amount.toString(),
      validAfter,
      validBefore,
      nonce: message.nonce,
      sig3009,
    };

    let sent = await daemonBroadcastSweep(payload);
    if (sent === null) {
      throw new Error('The AntSeed connection is not running — start it to complete the deposit. Your USDC is safe in the wallet.');
    }
    if (sent === 0) {
      await daemonConnectSweepRelayers();
      sent = await daemonBroadcastSweep(payload) ?? 0;
    }
    if (sent === 0) {
      throw new Error('No deposit relayers are reachable right now. Your USDC is safe in the wallet — retrying automatically.');
    }

    const result = await waitForSweepConfirmation({
      depositsClient: client,
      relayClient,
      buyer,
      initialTotal: depositsBalance,
      expectedNet: amount - fee,
      fee,
      usdcAddress: cc.usdcAddress,
      authNonce: message.nonce,
    });
    if (!result) {
      throw new Error('The deposit was not confirmed in time. Your USDC is safe in the wallet — retrying automatically.');
    }

    depositWatchBalance = await client.getUSDCBalance(buyer).catch(() => 0n);
    cachedCreditsInfo = null;
    sendDepositWatchStatus({
      phase: 'credited',
      amountBaseUnits: result.credited.toString(),
      ...(result.txHash ? { txHash: result.txHash } : {}),
    });
  } catch (err) {
    sendDepositWatchStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    depositSweepInFlight = false;
  }
}

async function pollDepositWatch(): Promise<void> {
  const identity = getSecureIdentity();
  const cc = await loadCachedCryptoConfig();
  if (!identity || !cc) return;
  const client = makeDepositsClient(cc);
  let balance: bigint;
  try {
    balance = await client.getUSDCBalance(identity.wallet.address);
  } catch {
    return; // transient RPC failure — try again next tick
  }
  if (balance > depositWatchBalance) {
    const delta = balance - depositWatchBalance;
    depositWatchBalance = balance;
    sendDepositWatchStatus({ phase: 'received', amountBaseUnits: delta.toString() });
    void sweepIncomingUsdc(client, identity.wallet.address);
  } else if (balance < depositWatchBalance) {
    depositWatchBalance = balance;
  } else if (balance > 0n && !depositSweepInFlight && Date.now() - depositSweepLastAttemptAt > SWEEP_RETRY_COOLDOWN_MS) {
    // Funds from an earlier failed/partial sweep are still sitting in the
    // wallet — retry once the cooldown passes.
    void sweepIncomingUsdc(client, identity.wallet.address);
  }
}

ipcMain.handle('deposits:watch-start', async () => {
  try {
    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    if (!identity) return { ok: false, error: 'Identity not available' };
    const cc = await loadCachedCryptoConfig();
    if (!cc) return { ok: false, error: 'No payment chain configured' };
    const client = makeDepositsClient(cc);
    const address = identity.wallet.address;
    let balance = 0n;
    try {
      balance = await client.getUSDCBalance(address);
    } catch {
      // RPC hiccup — the poll loop picks it up
    }
    depositWatchBalance = balance;
    if (!depositWatchTimer) {
      depositWatchTimer = setInterval(() => { void pollDepositWatch(); }, DEPOSIT_WATCH_INTERVAL_MS);
    }
    // USDC already sitting in the wallet (sent before the panel opened, or a
    // card purchase that landed while the app was closed) — sweep it now.
    if (balance > 0n) void sweepIncomingUsdc(client, address);
    return {
      ok: true,
      data: {
        address,
        walletUsdcBaseUnits: balance.toString(),
        usdcAddress: cc.usdcAddress,
        chainId: cc.chainId,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('deposits:watch-stop', () => {
  if (depositWatchTimer) {
    clearInterval(depositWatchTimer);
    depositWatchTimer = null;
  }
  return { ok: true };
});

// Max spending per session: $5 USDC = 5,000,000 base units. Main process enforces
// this cap to prevent a compromised renderer from signing unbounded authorizations.
const MAX_SPENDING_AUTH_BASE_UNITS = 5_000_000n;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const EMPTY_BUYER_USAGE_TOTALS: DesktopBuyerUsageTotals = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  activeChannels: 0,
};

const EMPTY_REWARDS_SUMMARY: DesktopRewardsSummary = {
  available: false,
  pendingAnts: '0',
  currentEpoch: null,
  transfersEnabled: false,
  error: null,
};

function readNumberField(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function readStringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function normalizeBuyerUsageTotals(value: unknown): DesktopBuyerUsageTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_BUYER_USAGE_TOTALS;
  }
  const raw = value as Record<string, unknown>;
  return {
    totalRequests: readNumberField(raw, 'totalRequests'),
    totalInputTokens: readStringField(raw, 'totalInputTokens') || '0',
    totalOutputTokens: readStringField(raw, 'totalOutputTokens') || '0',
    totalSettlements: readNumberField(raw, 'totalSettlements'),
    uniqueSellers: readNumberField(raw, 'uniqueSellers'),
    activeChannels: readNumberField(raw, 'activeChannels'),
  };
}

function normalizePaymentChannelSummary(value: unknown): DesktopPaymentChannelSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const channelId = readStringField(raw, 'channelId') || readStringField(raw, 'sessionId');
  if (!channelId) return null;
  return {
    channelId,
    peerId: readStringField(raw, 'peerId') || readStringField(raw, 'sellerPeerId'),
    seller: readStringField(raw, 'seller') || readStringField(raw, 'sellerAddress') || readStringField(raw, 'sellerEvmAddress'),
    reserveMax: readStringField(raw, 'reserveMax') || readStringField(raw, 'maxAmount') || readStringField(raw, 'reserveMaxBaseUnits') || '0',
    cumulativeSigned: readStringField(raw, 'cumulativeSigned') || readStringField(raw, 'latestCumulativeAmount') || readStringField(raw, 'cumulativeAmount') || '0',
    reservedAt: readNumberField(raw, 'reservedAt'),
    status: readStringField(raw, 'status') || 'unknown',
    requestCount: readNumberField(raw, 'requestCount'),
    inputTokens: readStringField(raw, 'tokensDelivered') || '0',
    outputTokens: readStringField(raw, 'outputTokens') || '0',
  };
}

async function fetchBuyerProxyJson(pathname: string): Promise<Record<string, unknown> | null> {
  const port = await resolveBuyerProxyPort();
  try {
    const response = await fetch(`${LOCALHOST_URL}:${port}${pathname}`);
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function formatAnts(value: bigint): string {
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = value % 1_000_000_000_000_000_000n;
  if (fraction === 0n) return whole.toString();
  const padded = fraction.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toString()}.${padded.slice(0, 6)}`;
}

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

ipcMain.handle('payments:get-buyer-usage', async (): Promise<{ ok: boolean; data: DesktopBuyerUsageTotals | null; error: string | null; lastActivityAt: number | null }> => {
  const body = await fetchBuyerProxyJson('/_antseed/buyer-usage');
  if (!body) {
    return { ok: false, data: null, error: 'buyer proxy unreachable', lastActivityAt: null };
  }
  const lastActivityAt = typeof body['lastActivityAt'] === 'number' ? body['lastActivityAt'] : null;
  return {
    ok: true,
    data: normalizeBuyerUsageTotals(body['totals']),
    error: null,
    lastActivityAt,
  };
});

// AntseedChannels grace period between requestClose() and withdraw().
const CHANNEL_CLOSE_GRACE_SECS = 900;
// Bound the on-chain enrichment fan-out per refresh.
const CHANNEL_ENRICH_MAX = 12;

// The local ChannelStore can lag the chain (a seller-side settle/close is not
// always observed), so rows that look active are re-checked on-chain before
// the activity view offers a Close action on a dead channel.
async function enrichChannelStatuses(channels: DesktopPaymentChannelSummary[]): Promise<void> {
  const cc = await loadCachedCryptoConfig();
  if (!cc?.channelsAddress) return;
  cachedChannelsClient ??= new ChannelsClient({
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    contractAddress: cc.channelsAddress,
    evmChainId: cc.chainId,
  });
  const client = cachedChannelsClient;
  const candidates = channels
    .filter((row) => row.status === 'active' || row.status === 'open')
    .slice(0, CHANNEL_ENRICH_MAX);
  await Promise.allSettled(candidates.map(async (row) => {
    const info = await client.getSession(row.channelId);
    const closeRequestedAt = Number(info.closeRequestedAt);
    if (info.status === 2) row.status = 'settled';
    else if (info.status === 3) row.status = 'timedout';
    else if (info.status === 1 && closeRequestedAt > 0) {
      const now = Math.floor(Date.now() / 1000);
      row.status = now < closeRequestedAt + CHANNEL_CLOSE_GRACE_SECS ? 'closing' : 'withdrawable';
    }
    // status 0 (no on-chain record) is ambiguous — a channel may exist
    // locally before its on-chain reserve lands. Keep the local status.
  }));
}

ipcMain.handle('payments:get-channels', async (): Promise<{ ok: boolean; data: DesktopPaymentChannelSummary[] | null; error: string | null }> => {
  const body = await fetchBuyerProxyJson('/_antseed/channels?all=1');
  if (!body) {
    return { ok: false, data: null, error: 'buyer proxy unreachable' };
  }
  const channels = Array.isArray(body['channels'])
    ? body['channels']
      .map((entry) => normalizePaymentChannelSummary(entry))
      .filter((entry): entry is DesktopPaymentChannelSummary => entry !== null)
    : [];
  await enrichChannelStatuses(channels).catch(() => {});
  return { ok: true, data: channels, error: null };
});

ipcMain.handle('payments:get-rewards-summary', async (): Promise<{ ok: boolean; data: DesktopRewardsSummary | null; error: string | null }> => {
  try {
    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    const cc = await loadCachedCryptoConfig();
    if (!identity || !cc?.emissionsAddress) {
      return { ok: true, data: EMPTY_REWARDS_SUMMARY, error: null };
    }

    cachedEmissionsClient ??= new EmissionsClient({
      rpcUrl: cc.rpcUrl,
      ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
      contractAddress: cc.emissionsAddress,
      evmChainId: cc.chainId,
    });
    const emissionsClient = cachedEmissionsClient;
    if (cc.antsTokenAddress) {
      cachedAntsTokenClient ??= new ANTSTokenClient({
        rpcUrl: cc.rpcUrl,
        ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
        contractAddress: cc.antsTokenAddress,
        evmChainId: cc.chainId,
      });
    }
    const tokenClient = cachedAntsTokenClient;
    // transfersEnabled only depends on the token address — run it in parallel
    // with the epoch + pending-emissions chain.
    const [{ currentEpoch, pending }, transfersEnabled] = await Promise.all([
      (async () => {
        const info = await emissionsClient.getEpochInfo();
        const startEpoch = Math.max(0, info.epoch - 9);
        const epochs = Array.from({ length: info.epoch - startEpoch + 1 }, (_, index) => startEpoch + index);
        return { currentEpoch: info.epoch, pending: await emissionsClient.pendingEmissions(identity.wallet.address, epochs) };
      })(),
      tokenClient ? tokenClient.transfersEnabled() : Promise.resolve(false),
    ]);

    return {
      ok: true,
      data: {
        available: true,
        pendingAnts: formatAnts(pending.seller + pending.buyer),
        currentEpoch,
        transfersEnabled,
        error: null,
      },
      error: null,
    };
  } catch (err) {
    return {
      ok: true,
      data: { ...EMPTY_REWARDS_SUMMARY, error: err instanceof Error ? err.message : String(err) },
      error: null,
    };
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
  const base = SYSTEM_PROXY_PROFILES.map((profile) => ({
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
  const custom = loadCustomAppRecords().map((record) => ({
    name: record.name,
    displayName: record.displayName,
    kind: 'proxy' as const,
    method: 'HTTPS proxy',
    domains: [record.host],
    canRestart: false,
    custom: true,
    ...(record.iconDataUri ? { iconDataUri: record.iconDataUri } : {}),
  }));
  return [...base, ...custom];
});

ipcMain.handle('system-proxy:add-custom-app', async (_event, opts: { apiUrl?: string }) => {
  try {
    const apiUrl = typeof opts?.apiUrl === 'string' ? opts.apiUrl.trim() : '';
    const target = deriveCustomAppTarget(apiUrl);
    const existingProfiles = allSystemProxyProfiles();
    const conflict = existingProfiles.find((profile) => profile.kind === 'proxy' && profile.domains.includes(target.host));
    if (conflict) {
      return { ok: false, error: `${target.host} is already handled by ${conflict.label}.` };
    }
    const metadata = await fetchCustomAppSiteMetadata(target.host);
    const dataDir = resolveConnectDataDir();
    const record: CustomAppRecord = {
      name: customAppName(target.host, existingProfiles.map((profile) => profile.name)),
      displayName: metadata.title ?? target.host,
      apiUrl,
      ...target,
      ...(metadata.iconDataUri ? { iconDataUri: metadata.iconDataUri } : {}),
      createdAt: Date.now(),
    };
    saveCustomApps(dataDir, [...loadCustomApps(dataDir), record]);
    refreshTrayMenu();
    return { ok: true, name: record.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('system-proxy:remove-custom-app', (_event, opts: { name?: string }) => {
  try {
    const name = typeof opts?.name === 'string' ? opts.name : '';
    const dataDir = resolveConnectDataDir();
    const existing = loadCustomApps(dataDir);
    if (!existing.some((record) => record.name === name)) {
      return { ok: false, error: 'Unknown custom app.' };
    }
    saveCustomApps(dataDir, existing.filter((record) => record.name !== name));
    refreshTrayMenu();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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

// Where the local HTTPS-interception CA lives on this device, for the Apps
// page's transparency panel. The cert is generated only when an intercepted
// (custom HTTPS) app first connects, so `exists` is false by default.
ipcMain.handle('system-proxy:ca-info', (): { path: string; exists: boolean } => {
  const caPath = systemProxyCaPath();
  return { path: caPath, exists: existsSync(caPath) };
});

ipcMain.handle('system-proxy:reveal-ca', (): { ok: boolean; error?: string } => {
  const caPath = systemProxyCaPath();
  if (!existsSync(caPath)) {
    return { ok: false, error: 'No certificate has been created yet. Connect an intercepted HTTPS app first.' };
  }
  shell.showItemInFolder(caPath);
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/*  Floating always-on-top pill window                                  */
/* ------------------------------------------------------------------ */

// Cache the latest display payload so a freshly opened float window can be
// primed before the main window's next periodic update.
let lastVprFloatData: unknown;

ipcMain.handle('vpr-float:open', (_event, data: unknown) => {
  if (data !== undefined) lastVprFloatData = data;
  openFloatWindow(
    { appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl },
    lastVprFloatData,
  );
  return { ok: true };
});

ipcMain.handle('vpr-float:close', () => {
  closeFloatWindow();
  return { ok: true };
});

ipcMain.handle('vpr-float:is-open', () => Boolean(getFloatWindow()));

ipcMain.handle('vpr-float:get-compact', () => getFloatWindowCompact());

ipcMain.on('vpr-float:update', (_event, data: unknown) => {
  lastVprFloatData = data;
  getFloatWindow()?.webContents.send('vpr-float:data', data);
});

ipcMain.on('vpr-float:action', (_event, action: unknown) => {
  if (action === 'open-main') {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return;
  }
  if (
    typeof action === 'object' && action !== null
    && (action as { type?: unknown }).type === 'set-compact'
  ) {
    setFloatWindowCompact((action as { compact?: unknown }).compact === true);
    return;
  }
  // Structured actions (e.g. model selection) are handled by the main
  // window's renderer, which owns routing state.
  getMainWindow()?.webContents.send('vpr-float:action', action);
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

  // Stale System Proxy cleanup (no persisted state) — fire-and-forget so clean
  // launches don't block window creation on networksetup/reg calls.
  if (!activeSystemProxyState) {
    void clearSystemProxySettings().catch((err) => {
      appendLog('system-proxy', 'system', `System Proxy cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

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
  if (restoredProfiles.length > 0 && typeof activeSystemProxyState?.['peerId'] === 'string') {
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
  let updateVersion: string | null = null;

  const sendUpdateStatus = (status: UpdateStatus) => {
    getMainWindow()?.webContents.send('app:update-status', status);
  };

  const clearStallWatchdog = () => {
    if (downloadStallInterval) {
      clearInterval(downloadStallInterval);
      downloadStallInterval = null;
    }
    lastDownloadProgressAt = null;
    lastDownloadPercent = 0;
  };

  const reportUpdateError = (error: unknown, context: string): InstallUpdateResult => {
    const message = errorMessage(error);
    const details = errorDetails(error);
    const hint = getMacUpdateInstallHint();
    console.error(`[auto-update] ${context}:`, details);
    appendLog('connect', 'system', `Auto-update ${context}: ${message}`);
    clearStallWatchdog();
    if (isInstallingUpdate) {
      isQuitting = false;
    }
    isInstallingUpdate = false;
    sendUpdateStatus({ status: 'error', version: updateVersion, message, details, hint });
    updateVersion = null;
    return { ok: false, error: message, details, hint };
  };

  const startStallWatchdog = () => {
    clearStallWatchdog();
    lastDownloadProgressAt = Date.now();
    downloadStallInterval = setInterval(() => {
      if (!updateVersion || lastDownloadProgressAt === null) return;
      // Once bytes are done electron-updater still spends time verifying the
      // file (sha512 / code-sign) and emits no progress — don't treat that as
      // a stall, just wait for update-downloaded.
      if (lastDownloadPercent >= 100) return;
      const idleMs = Date.now() - lastDownloadProgressAt;
      if (idleMs < DOWNLOAD_STALL_TIMEOUT_MS) return;
      console.warn(`[auto-update] download stalled (${Math.round(idleMs / 1000)}s with no progress) — retrying`);
      clearStallWatchdog();
      updateVersion = null;
      void autoUpdater.checkForUpdates().catch((err) => {
        reportUpdateError(err, 'stall-retry failed');
      });
    }, DOWNLOAD_STALL_POLL_MS);
  };

  autoUpdater.on('update-available', (info) => {
    updateVersion = info.version;
    startStallWatchdog();
    sendUpdateStatus({ status: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (!updateVersion) return;
    lastDownloadProgressAt = Date.now();
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
    lastDownloadPercent = percent;
    sendUpdateStatus({
      status: 'downloading',
      version: updateVersion,
      percent,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateVersion = info.version;
    clearStallWatchdog();
    sendUpdateStatus({ status: 'ready', version: info.version });
    if (updateCheckInterval) {
      clearInterval(updateCheckInterval);
      updateCheckInterval = null;
    }
  });
  autoUpdater.on('error', (err) => {
    reportUpdateError(err, 'error');
  });

  void autoUpdater.checkForUpdates().catch(() => {});

  updateCheckInterval = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);

  ipcMain.handle('app:install-update', async (): Promise<InstallUpdateResult> => {
    if (isInstallingUpdate) {
      return { ok: true };
    }

    isInstallingUpdate = true;
    sendUpdateStatus({ status: 'installing', version: updateVersion });

    try {
      await stopDesktopServices();
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      isQuitting = false;
      return reportUpdateError(err, 'install failed');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  isQuitting = true;

  void stopDesktopServices().finally(() => {
    app.exit(0);
  });
});

// Ensure child processes are cleaned up if the main process receives a terminal
// stop signal before before-quit fires.
process.on('SIGINT', () => {
  void stopDesktopServices().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void stopDesktopServices().finally(() => process.exit(0));
});

// Suppress EPIPE errors from console.error/console.warn when the dev terminal
// pipe is closed (e.g. Ctrl+C in the terminal while Electron is still running).
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});
