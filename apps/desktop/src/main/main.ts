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
import { ensureSecureIdentity, secureIdentityEnv, getSecureIdentity } from './identity.js';
import { identityToEvmAddress, identityToEvmWallet, BaseEscrowClient, signSpendingAuth, makeEscrowDomain, resolveChainConfig, formatUsdc } from '@antseed/node';
import { createServer as createPaymentsServer } from '@antseed/payments';
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

async function isManualApprovalEnabled(): Promise<boolean> {
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const buyer = config.buyer && typeof config.buyer === 'object' ? config.buyer as Record<string, unknown> : {};
    return Boolean(buyer.requireManualApproval);
  } catch {
    return false;
  }
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

// Pending payment approval requests from the CLI child process, keyed by peerId.
const pendingPaymentApprovals = new Map<string, {
  resolve: (decision: { approved: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// When the CLI requests payment approval, forward to the renderer and wait.
processManager.onPaymentApprovalRequest = async (info) => {
  const peerId = typeof info.peerId === 'string' ? info.peerId : '';
  const win = getMainWindow();
  if (!win) {
    return { approved: false };
  }

  return new Promise<{ approved: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingPaymentApprovals.has(peerId)) {
        pendingPaymentApprovals.delete(peerId);
        resolve({ approved: false });
      }
    }, 60_000);
    pendingPaymentApprovals.set(peerId, { resolve, timer });
    win.webContents.send('payments:approval-required', info);
  });
};

// Renderer sends approval/rejection back
ipcMain.handle('payments:approve-session', async (_event, peerId: string, approved: boolean) => {
  const pending = pendingPaymentApprovals.get(peerId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingPaymentApprovals.delete(peerId);
    pending.resolve({ approved });
  }
  return { ok: true };
});

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
    await paymentsServer.listen({ port: PAYMENTS_PORT, host: '127.0.0.1' });
    console.log(`[desktop] Payments portal running at http://127.0.0.1:${PAYMENTS_PORT}`);
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

ipcMain.handle('payments:open-portal', async () => {
  try {
    await startPaymentsPortal();
    // Pass bearer token via URL param so the portal frontend can authenticate POST requests
    const token = paymentsServer ? (paymentsServer as unknown as { bearerToken?: string }).bearerToken : '';
    const url = token
      ? `http://127.0.0.1:${PAYMENTS_PORT}?token=${token}`
      : `http://127.0.0.1:${PAYMENTS_PORT}`;
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

ipcMain.handle('runtime:get-state', async () => {
  return {
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
    logs: [...logBuffer],
  };
});

ipcMain.handle('runtime:start', async (_event, options: StartOptions) => {
  await ensureSecureIdentity();

  const manualApproval = await isManualApprovalEnabled();

  const startOptions: StartOptions = {
    ...options,
    ...(desktopDebugEnabled ? { verbose: true } : {}),
    env: {
      ...(options.env ?? {}),
      ...(desktopDebugEnabled ? { ANTSEED_DEBUG: '1' } : {}),
      ...secureIdentityEnv(),
      ...(manualApproval ? { ANTSEED_PAYMENT_APPROVAL_IPC: '1' } : {}),
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
      cachedCryptoConfig = null; // Invalidate cached crypto config
      return { ok: true, data: { config: merged }, error: null, status: 200 };
    } catch (err) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null };
    }
  },
);

// ── Credits / Escrow Balance ──

type CreditsInfo = {
  evmAddress: string | null;
  balanceUsdc: string;
  reservedUsdc: string;
  availableUsdc: string;
  pendingWithdrawalUsdc: string;
  creditLimitUsdc: string;
};

// Use shared formatUsdc from @antseed/node
const formatUsdc6 = formatUsdc;

let cachedCreditsInfo: CreditsInfo | null = null;

// Cached crypto config — invalidated on config update. Uses protocol defaults
// from resolveChainConfig with optional user overrides from config.json.
let cachedCryptoConfig: { rpcUrl: string; escrowAddress: string; usdcAddress: string; chainId: number } | null = null;

async function loadCachedCryptoConfig(): Promise<typeof cachedCryptoConfig> {
  if (cachedCryptoConfig) return cachedCryptoConfig;
  let overrides: Record<string, unknown> = {};
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const payments = asRecord(config.payments);
    overrides = asRecord(payments.crypto);
  } catch {
    // No config — use protocol defaults
  }
  const cc = resolveChainConfig({
    chainId: asString(overrides.chainId as string, '') || undefined,
    rpcUrl: asString(overrides.rpcUrl as string, '') || undefined,
    escrowContractAddress: asString(overrides.escrowContractAddress as string, '') || undefined,
    usdcContractAddress: asString(overrides.usdcContractAddress as string, '') || undefined,
  });
  cachedCryptoConfig = { rpcUrl: cc.rpcUrl, escrowAddress: cc.escrowContractAddress, usdcAddress: cc.usdcContractAddress, chainId: cc.evmChainId };
  return cachedCryptoConfig;
}

async function refreshCreditsInfo(): Promise<CreditsInfo> {
  const identity = getSecureIdentity();
  if (!identity) {
    return { evmAddress: null, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', pendingWithdrawalUsdc: '0', creditLimitUsdc: '0' };
  }

  const evmAddress = identityToEvmAddress(identity);
  const cc = await loadCachedCryptoConfig();
  if (!cc) {
    return { evmAddress, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', pendingWithdrawalUsdc: '0', creditLimitUsdc: '0' };
  }

  const client = new BaseEscrowClient({ rpcUrl: cc.rpcUrl, contractAddress: cc.escrowAddress, usdcAddress: cc.usdcAddress });

  try {
    const [balance, creditLimit] = await Promise.all([
      client.getBuyerBalance(evmAddress),
      client.getBuyerCreditLimit(evmAddress),
    ]);
    const info: CreditsInfo = {
      evmAddress,
      balanceUsdc: formatUsdc6(balance.available + balance.reserved),
      reservedUsdc: formatUsdc6(balance.reserved),
      availableUsdc: formatUsdc6(balance.available),
      pendingWithdrawalUsdc: formatUsdc6(balance.pendingWithdrawal),
      creditLimitUsdc: formatUsdc6(creditLimit),
    };
    cachedCreditsInfo = info;
    return info;
  } catch (err) {
    console.error('[credits] Failed to fetch escrow balance:', err instanceof Error ? err.message : String(err));
    if (cachedCreditsInfo) return cachedCreditsInfo;
    return { evmAddress, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', pendingWithdrawalUsdc: '0', creditLimitUsdc: '0' };
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

// FIRST_SIGN_CAP: 1 USDC = 1,000,000 base units. Main process enforces this cap
// to prevent a compromised renderer from signing unbounded spending authorizations.
const MAX_SPENDING_AUTH_BASE_UNITS = 1_000_000n;
const MAX_DEADLINE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

ipcMain.handle('payments:sign-spending-auth', async (_event, params: {
  sellerEvmAddress: string;
  sessionId: string;
  maxAmountBaseUnits: string;
  nonce: number;
  deadline: number;
  previousConsumption: string;
  previousSessionId: string;
}) => {
  try {
    // Validate renderer-supplied parameters at the trust boundary
    if (!ETH_ADDRESS_RE.test(params.sellerEvmAddress)) {
      return { ok: false, error: 'Invalid seller EVM address' };
    }
    if (!BYTES32_RE.test(params.sessionId)) {
      return { ok: false, error: 'Invalid session ID format' };
    }
    const maxAmount = BigInt(params.maxAmountBaseUnits);
    if (maxAmount <= 0n || maxAmount > MAX_SPENDING_AUTH_BASE_UNITS) {
      return { ok: false, error: `maxAmount exceeds cap (${MAX_SPENDING_AUTH_BASE_UNITS} base units)` };
    }
    if (!Number.isInteger(params.nonce) || params.nonce < 0) {
      return { ok: false, error: 'Invalid nonce' };
    }
    if (!BYTES32_RE.test(params.previousSessionId)) {
      return { ok: false, error: 'Invalid previousSessionId format' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (params.deadline < now || params.deadline > now + MAX_DEADLINE_SECONDS) {
      return { ok: false, error: 'Deadline out of acceptable range' };
    }

    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    if (!identity) {
      return { ok: false, error: 'Identity not available' };
    }

    const cc = await loadCachedCryptoConfig();
    if (!cc) {
      return { ok: false, error: 'No escrow contract configured' };
    }

    const wallet = identityToEvmWallet(identity);
    const domain = makeEscrowDomain(cc.chainId, cc.escrowAddress);

    const signature = await signSpendingAuth(wallet, domain, {
      seller: params.sellerEvmAddress,
      sessionId: params.sessionId,
      maxAmount,
      nonce: params.nonce,
      deadline: params.deadline,
      previousConsumption: BigInt(params.previousConsumption),
      previousSessionId: params.previousSessionId,
    });

    const buyerEvmAddress = identityToEvmAddress(identity);

    return {
      ok: true,
      data: {
        signature,
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
        onChainReputation: (peer as Record<string, unknown>).onChainReputation ?? null,
        onChainSessionCount: (peer as Record<string, unknown>).onChainSessionCount ?? null,
        onChainDisputeCount: (peer as Record<string, unknown>).onChainDisputeCount ?? null,
        evmAddress: (peer as Record<string, unknown>).evmAddress ?? null,
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

    const chatManualApproval = await isManualApprovalEnabled();

    const startOptions: StartOptions = {
      mode: 'connect',
      router: 'local',
      ...(desktopDebugEnabled ? { verbose: true } : {}),
      env: {
        ...(desktopDebugEnabled ? { ANTSEED_DEBUG: '1' } : {}),
        ...secureIdentityEnv(),
        ...(chatManualApproval ? { ANTSEED_PAYMENT_APPROVAL_IPC: '1' } : {}),
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

  // Reject all pending payment approvals so CLI processes aren't left hanging
  for (const [, pending] of pendingPaymentApprovals) {
    clearTimeout(pending.timer);
    pending.resolve({ approved: false });
  }
  pendingPaymentApprovals.clear();

  void processManager.stopAll()
    .then(() => stopPaymentsPortal())
    .finally(() => {
      app.quit();
    });
});

// Ensure child processes are cleaned up if the main process receives SIGTERM
// (e.g. dev runner Ctrl+C kills Electron before before-quit fires).
process.on('SIGTERM', () => {
  void Promise.all([processManager.stopAll(), stopPaymentsPortal()]).finally(() => process.exit(0));
});
