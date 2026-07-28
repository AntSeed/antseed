import {
  app,
  BrowserWindow,
  ipcMain,
} from 'electron';
import { execFileSync } from 'node:child_process';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { isIP } from 'node:net';
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
  type StartOptions,
} from './runtime/process-manager.js';
import { registerPiChatHandlers } from './chat/engine.js';
import { emitChatEvent } from './chat/event-bus.js';
import { createTelegramBridge } from './telegram/bridge.js';
import { ensureSecureIdentity, secureIdentityEnv } from './identity.js';
import type { LogEvent, RuntimeActivityEvent } from './runtime/log-parser.js';
import { parseRuntimeActivityFromLog } from './runtime/log-parser.js';
import {
  setPluginAppendLog,
  ensureDefaultPlugin,
} from './runtime/plugins.js';
import {
  refreshPeerCache,
  getNetworkSnapshot,
  onPeersChanged,
  type DashboardNetworkPeer,
} from './runtime/peer-cache.js';
import {
  createWindow,
  createApplicationMenu,
  getMainWindow,
} from './ui/window.js';
import { createDesktopTray } from './ui/tray.js';
import { ensureConfig } from './runtime/config-io.js';
import { registerAttachmentScheme, installAttachmentProtocol } from './chat/attachments/protocol.js';
import {
  APP_ICON_PATH,
  APP_NAME,
  INTERNAL_APP_NAME,
  TRAY_ICON_PATH,
  errorDetails,
  errorMessage,
  getAppSetupStatus,
  getMacUpdateInstallHint,
  isDesktopDebugEnabled,
  isDev,
  rendererUrl,
  setAppSetupStatus,
  type InstallUpdateResult,
  type UpdateStatus,
} from './app-context.js';
import {
  buildSystemProxyTrayMenu,
  clearSystemProxySettings,
  clearSystemProxyTransportSettings,
  getActiveSystemProxyState,
  initSystemProxyRuntime,
  loadPersistedSystemProxyState,
  refreshTrayMenu,
  restoreSystemProxyProfilesAtLaunch,
  startSystemProxyWatchdog,
  stopManagedRuntimes,
} from './system-proxy/runtime.js';
import { LOCALHOST_URL } from './constants.js';
import { registerAppIpc } from './ipc/app.js';
import { registerDesktopIpc } from './ipc/desktop.js';
import { registerFloatIpc } from './ipc/float.js';
import { registerPaymentsIpc } from './ipc/payments.js';
import { registerRuntimeIpc } from './ipc/runtime.js';
import { registerSystemProxyIpc } from './ipc/system-proxy.js';
import { registerTelegramIpc } from './ipc/telegram.js';
import {
  effectiveLaunchTarget,
} from './connected-apps/profile-targets.js';
import {
  stopPaymentsPortal,
} from './payments/portal.js';
import { ACTIVE_CONFIG_PATH } from './runtime/active-config.js';
import {
  restoreOsSystemProxySync,
} from './system-proxy/os-settings.js';
import {
  DEFAULT_SYSTEM_PROXY_PORT,
} from './system-proxy/profiles.js';
import { resolveBuyerProxyPort } from './runtime/active-config.js';

// Re-export types that may be used by other main-process modules
export type { LogEvent, RuntimeActivityEvent } from './runtime/log-parser.js';
export type { DashboardNetworkPeer, DashboardNetworkStats, DashboardNetworkResult } from './runtime/peer-cache.js';
export type { InstalledPlugin } from './runtime/plugins.js';

// Internal runtime name — NEVER change this value. On macOS the safeStorage
// encryption key lives in the "<app.setName value> Safe Storage" keychain
// entry, and the default userData path derives from it too. Renaming it
// rotates the key and orphans every existing identity.enc. User-visible
// surfaces use APP_NAME below instead.

let isQuitting = false;
let isInstallingUpdate = false;

// The `antseed-attachment://` scheme must be registered as privileged
// *before* `app.whenReady()` fires. The actual request handler is wired
// inside whenReady() once Electron's protocol module is usable.
registerAttachmentScheme();

const logBuffer: LogEvent[] = [];
let lastRuntimeActivityHash = '';

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

/**
 * Kill any leftover process still listening on the buyer proxy port after the
 * desktop's own runtime child was stopped. The CLI reuses a compatible
 * listener instead of failing on EADDRINUSE, so an orphaned runtime from an
 * earlier session can keep the proxy alive — chats keep working and the UI
 * reads as connected even though Stop was pressed. Only processes from our
 * own runtime family (node/antseed/electron) are reaped.
 */
async function killOrphanBuyerProxy(): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const port = await resolveBuyerProxyPort();
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out
      .split(/\s+/)
      .map((raw) => Number(raw))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    for (const pid of pids) {
      let command = '';
      try {
        command = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        continue; // Already gone.
      }
      if (!/node|antseed|electron/i.test(command)) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  } catch {
    // lsof unavailable or nothing listening — nothing to reap.
  }
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

initSystemProxyRuntime({
  appName: APP_NAME,
  appendLog,
  processManager,
  effectiveLaunchTarget: (profileName) => effectiveLaunchTarget(profileName),
});

// ── Payments Portal ──

async function stopDesktopServices(): Promise<void> {
  await Promise.all([telegramBridge.stop(), stopManagedRuntimes(), stopPaymentsPortal()]);
}

function getCombinedProcessState(): RuntimeProcessState[] {
  return processManager.getState();
}

// ── IPC handlers ──
// Each group lives in ipc/<domain>.ts; anything they need from this file is
// passed in rather than reached for.
registerPaymentsIpc();
registerDesktopIpc();
registerAppIpc();
registerFloatIpc();
registerSystemProxyIpc({ processManager });
registerRuntimeIpc({
  processManager,
  logBuffer,
  appendLog,
  getCombinedProcessState,
  killOrphanBuyerProxy,
  requestBuyerPeerRefresh,
});

// Allowlisted top-level keys that the renderer is permitted to update via IPC.
// Any key not in this set is stripped before the request is forwarded to the
// dashboard API, preventing a compromised renderer from overwriting arbitrary
// config fields.

// ── Credits / Deposits Balance ──

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

// ── AI Chat IPC Handlers ──
const piChatEngine = registerPiChatHandlers({
  ipcMain,
  sendToRenderer: (channel, payload) => {
    getMainWindow()?.webContents.send(channel, payload);
    // Tee every chat event into the bus so the Telegram bridge can follow
    // stream deltas, completions, and tool-approval requests.
    emitChatEvent(channel, payload);
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
      ...(isDesktopDebugEnabled() ? { verbose: true } : {}),
      env: {
        ...(isDesktopDebugEnabled() ? { ANTSEED_DEBUG: '1' } : {}),
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

// ── Telegram bridge ──
const telegramBridge = createTelegramBridge({
  engine: piChatEngine,
  appendLog: (line) => { appendLog('connect', 'system', line); },
  onStatusChanged: (status) => {
    getMainWindow()?.webContents.send('telegram:status-changed', status);
  },
});

registerTelegramIpc({ telegramBridge });

/* ------------------------------------------------------------------ */
/*  Floating always-on-top pill window                                  */
/* ------------------------------------------------------------------ */

// Cache the latest display payload so a freshly opened float window can be
// primed before the main window's next periodic update.

app.whenReady().then(async () => {
  installAttachmentProtocol();
  app.setName(INTERNAL_APP_NAME);
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
    // Windows only, and the reason this is here rather than on `app`:
    // 'before-quit' is NOT emitted when the app goes down with an OS shutdown,
    // restart or logout, so this is the last chance to hand the proxy setting
    // back — and there is only time for the synchronous restore. Without it
    // the machine reboots into a system proxy pointing at nothing.
    getMainWindow()?.on('session-end', () => {
      restoreOsSystemProxySync();
    });
  };

  showMainWindow();

  // Fail open before anything else. Whatever the OS proxy is set to right now
  // was left behind by the previous run — and if that run ended in a crash,
  // a force-quit or an OS shutdown, it still points at a proxy that is not
  // running, which is the whole machine offline. Restore it unconditionally
  // and let the reconnect below re-arm it only once a proxy really listens.
  // Fire-and-forget so clean launches don't block window creation on
  // networksetup/reg calls; only the state files differ between the two cases
  // (persisted state is the reconnect memory and must survive).
  const systemProxyFailOpen = (getActiveSystemProxyState()
    ? clearSystemProxyTransportSettings()
    : clearSystemProxySettings()
  ).catch((err) => {
    appendLog('system-proxy', 'system', `System Proxy cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  startSystemProxyWatchdog();

  createDesktopTray({
    appName: APP_NAME,
    iconPath: TRAY_ICON_PATH,
    onShow: showMainWindow,
    buildMenu: () => buildSystemProxyTrayMenu(showMainWindow),
  });
  refreshTrayMenu();

  const restoredState = getActiveSystemProxyState();
  const restoredProfiles = Array.isArray(restoredState?.['activeProfileNames'])
    ? restoredState['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  if (restoredProfiles.length > 0 && typeof restoredState?.['peerId'] === 'string') {
    const restorePeerId = restoredState['peerId'];
    const restoreDefaultModel = typeof restoredState['defaultModel'] === 'string'
      ? restoredState['defaultModel'] as string
      : undefined;
    // Sequenced after the fail-open above, or the clear could land after the
    // child has already re-armed the setting and silently disconnect it.
    void systemProxyFailOpen.then(() => restoreSystemProxyProfilesAtLaunch({
      peerId: restorePeerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: restoredProfiles,
      defaultModel: restoreDefaultModel,
      servedModels: [],
      profileSwitch: true,
    })).catch((err) => {
      appendLog('system-proxy', 'system', `System Proxy auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Pre-load identity from encrypted store so it's ready before the first CLI spawn.
  void ensureSecureIdentity().catch(() => {
    // Failure is logged inside ensureSecureIdentity; CLI falls back to file-based identity.
  });

  // Resume the Telegram bridge if a bot was connected in a previous session.
  // Needs app-ready because the token store decrypts via safeStorage.
  void telegramBridge.start().catch((err) => {
    appendLog('connect', 'system', `[telegram] Bridge resume failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Payments portal starts lazily on first open (via payments:open-portal IPC)

  void ensureDefaultPlugin('@antseed/router-local', {
    getAppSetupNeeded: () => getAppSetupStatus().needed,
    setAppSetupNeeded: (v) => { setAppSetupStatus({ needed: v }); },
    getAppSetupComplete: () => getAppSetupStatus().complete,
    setAppSetupComplete: (v) => { setAppSetupStatus({ complete: v }); },
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

  // First, and synchronously: the async teardown below waits on child
  // processes and can be cut short (Windows gives an app only a few seconds
  // to quit at logout/shutdown before killing it). An OS proxy left pointing
  // at the dead port breaks networking machine-wide, so it must not be
  // downstream of anything that can block.
  restoreOsSystemProxySync();

  void stopDesktopServices().finally(() => {
    app.exit(0);
  });
});

// Ensure child processes are cleaned up if the main process receives a terminal
// stop signal before before-quit fires.
process.on('SIGINT', () => {
  restoreOsSystemProxySync();
  void stopDesktopServices().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  restoreOsSystemProxySync();
  void stopDesktopServices().finally(() => process.exit(0));
});

// Suppress EPIPE errors from console.error/console.warn when the dev terminal
// pipe is closed (e.g. Ctrl+C in the terminal while Electron is still running).
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});
