/**
 * Starting, stopping and restarting the desktop applications attached to app
 * profiles.
 *
 * Connecting a running app to the proxy needs it restarted to pick up the new
 * settings, and "restart" means something different per platform and per app
 * kind — a Chromium app spawns its renderer only once a window exists, an
 * `open -a` target has no bundle path at all. Those distinctions live here.
 */
import { shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AppLaunchTarget } from './launch-settings.js';
import { launchAppTarget, listInstalledApplications } from './installed.js';

export function isCertificateTrustError(message: string): boolean {
  return /certificate|cert_|err_cert|authority|trust|ssl|tls/i.test(message);
}

export type AppProcessInfo = { running: boolean; pid?: number; startedAt?: number };

const managedAppProcesses = new Map<string, number>();

function appTargetKey(target: AppLaunchTarget): string {
  return `${target.name}\u0000${target.path}`;
}

export function getMacAppProcessInfo(appName: string): AppProcessInfo {
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

export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function windowsExecutablePath(targetPath: string): string | null {
  if (process.platform !== 'win32') return null;
  if (path.extname(targetPath).toLowerCase() === '.exe') return targetPath;
  if (!targetPath.toLowerCase().endsWith('.lnk')) return null;
  try {
    const executable = shell.readShortcutLink(targetPath).target;
    return executable && path.extname(executable).toLowerCase() === '.exe' ? executable : null;
  } catch {
    return null;
  }
}

/** Whether the application behind a launch target has a live process. macOS
    matches the bundle's executable directory, so an Electron app's helper
    processes count; Windows matches the executable image name, and a `.lnk`
    shortcut carries no resolvable image so it reads as not running. */
export function appTargetProcessInfo(target: AppLaunchTarget): AppProcessInfo {
  if (process.platform === 'darwin') {
    if (!target.path.endsWith('.app')) return getMacAppProcessInfo(target.name);
    try {
      const raw = execFileSync('pgrep', ['-f', escapeRegExpLiteral(`${target.path}/Contents/MacOS/`)], { encoding: 'utf8' }).trim();
      const pid = Number(raw.split('\n')[0]?.trim());
      if (!Number.isFinite(pid) || pid <= 0) return { running: false };
      let startedAt: number | undefined;
      try {
        const startRaw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
        const parsed = Date.parse(startRaw);
        if (Number.isFinite(parsed)) startedAt = parsed;
      } catch { /* best-effort */ }
      return { running: true, pid, startedAt };
    } catch {
      return { running: false };
    }
  }
  if (process.platform === 'win32') {
    const executable = windowsExecutablePath(target.path);
    if (!executable) return { running: false };
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Name '${path.basename(executable, '.exe').replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Id.ToString() + '|' + $p.StartTime.ToUniversalTime().ToString('o') }`],
        { encoding: 'utf8' },
      ).trim();
      const [pidText, startedText] = out.split('|');
      const pid = Number(pidText);
      const startedAt = startedText ? Date.parse(startedText) : NaN;
      return Number.isFinite(pid) && pid > 0
        ? { running: true, pid, ...(Number.isFinite(startedAt) ? { startedAt } : {}) }
        : { running: false };
    } catch {
      return { running: false };
    }
  }
  return { running: false };
}

export function isAppTargetRunning(target: AppLaunchTarget): boolean {
  return appTargetProcessInfo(target).running;
}

export function markAppTargetManaged(target: AppLaunchTarget, launchedAt = Date.now()): void {
  managedAppProcesses.set(appTargetKey(target), launchedAt);
}

export function appTargetNeedsRestart(target: AppLaunchTarget, connectedAt: number | null): boolean {
  const processInfo = appTargetProcessInfo(target);
  if (!processInfo.running) return false;
  const managedAt = managedAppProcesses.get(appTargetKey(target));
  if (!managedAt) return true;
  if (processInfo.startedAt && processInfo.startedAt > managedAt + 2_000) return true;
  return connectedAt !== null && managedAt < connectedAt;
}

/** Name-only targets (`open -a Claude`) carry no bundle path, so the window
    check below has nothing to match — fill it in from the usual install
    locations when the name maps to a bundle. */
export function bundleForAppTarget(target: AppLaunchTarget): AppLaunchTarget {
  if (process.platform !== 'darwin' || target.path.endsWith('.app')) return target;
  for (const dir of ['/Applications', path.join(homedir(), 'Applications')]) {
    const candidate = path.join(dir, `${target.name}.app`);
    if (existsSync(candidate)) return { name: target.name, path: candidate };
  }
  return target;
}

/** Whether a bundle is a Chromium/Electron app — those get the stronger
    window-is-up check below. */
export function isElectronAppTarget(target: AppLaunchTarget): boolean {
  if (process.platform !== 'darwin' || !target.path.endsWith('.app')) return false;
  return existsSync(path.join(target.path, 'Contents', 'Frameworks', 'Electron Framework.framework'));
}

/** A Chromium app spawns its renderer helper only once a window is created, so
    this is the closest permission-free signal we have to "the UI is up" — the
    main process alone is alive seconds earlier, while the app is still booting. */
export function hasAppTargetWindowProcess(target: AppLaunchTarget): boolean {
  const pattern = `${escapeRegExpLiteral(`${target.path}/Contents/Frameworks/`)}.*${escapeRegExpLiteral('Helper (Renderer)')}`;
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function quitAppTarget(target: AppLaunchTarget): void {
  if (process.platform === 'darwin') {
    // By POSIX path when we have one: two same-named bundles in /Applications
    // and ~/Applications would otherwise be ambiguous.
    const reference = target.path.endsWith('.app') ? target.path : target.name;
    execFileSync('osascript', ['-e', `tell application "${reference.replace(/(["\\])/g, '\\$1')}" to quit`], { stdio: 'pipe' });
    return;
  }
  if (process.platform === 'win32') {
    const executable = windowsExecutablePath(target.path);
    if (executable) execFileSync('taskkill', ['/IM', path.basename(executable)], { stdio: 'pipe' });
  }
}

export function killAppTarget(target: AppLaunchTarget): void {
  if (process.platform === 'darwin') {
    const args = target.path.endsWith('.app')
      ? ['-f', escapeRegExpLiteral(`${target.path}/Contents/MacOS/`)]
      : ['-x', target.name];
    execFileSync('pkill', args, { stdio: 'pipe' });
    return;
  }
  if (process.platform === 'win32') {
    const executable = windowsExecutablePath(target.path);
    if (executable) execFileSync('taskkill', ['/F', '/IM', path.basename(executable)], { stdio: 'pipe' });
  }
}

/**
 * Quit and relaunch an application so it re-reads what we just changed — both
 * config-patch files and the system HTTPS proxy are read at startup.
 *
 * `force` kills the app when it doesn't quit within the grace period; leave it
 * off for automatic restarts, where an app holding a "save changes?" dialog
 * must be left alone rather than killed out from under the user.
 */
export async function restartAppTarget(
  target: AppLaunchTarget,
  opts: { force?: boolean; launchIfStopped?: boolean; env?: Record<string, string> } = {},
): Promise<{ ok: boolean; restarted: boolean; error?: string }> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { ok: false, restarted: false, error: `Restarting ${target.name} is not supported on this platform.` };
  }
  // `open` hands off to LaunchServices and returns immediately, so wait for
  // the process to actually come back — the caller's busy state is what tells
  // the user the app is on its way.
  const launch = async (): Promise<{ ok: boolean; restarted: boolean; error?: string }> => {
    const result = launchAppTarget(target, { env: opts.env });
    if (result.ok) {
      markAppTargetManaged(target);
      await waitForAppTarget(target);
    }
    return { ok: result.ok, restarted: result.ok, ...(result.error ? { error: result.error } : {}) };
  };

  if (!isAppTargetRunning(target)) {
    if (!opts.launchIfStopped) return { ok: true, restarted: false };
    return { ...(await launch()), restarted: false };
  }

  try {
    quitAppTarget(target);
  } catch {
    // Continue: the app may not respond to AppleScript / may already be gone.
  }
  const startedWaitingAt = Date.now();
  while (Date.now() - startedWaitingAt < 10_000 && isAppTargetRunning(target)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (isAppTargetRunning(target)) {
    if (!opts.force) {
      return { ok: false, restarted: false, error: `${target.name} did not quit — restart it manually to pick up the new settings.` };
    }
    try {
      killAppTarget(target);
    } catch { /* best-effort */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return launch();
}

/**
 * Wait for a launched app to be usable, not merely alive: `open` returns as soon
 * as LaunchServices accepts the request, and a Chromium app's main process comes
 * up seconds before its window paints. Callers use this to hold a busy state, so
 * it is bounded — apps we can't read a window signal from fall back to the
 * process check they had before.
 */
export async function waitForAppTarget(target: AppLaunchTarget, timeoutMs = 30_000): Promise<void> {
  const startedWaitingAt = Date.now();
  const expired = () => Date.now() - startedWaitingAt >= timeoutMs;
  while (!expired() && !isAppTargetRunning(target)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const bundle = bundleForAppTarget(target);
  if (!isElectronAppTarget(bundle)) return;
  while (!expired() && !hasAppTargetWindowProcess(bundle)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Restart an app we know only by name. `restartAppTarget` handles macOS and
    Windows; the name is resolved to a real target first because Windows can't
    launch by name alone. */
export async function restartNamedApp(
  appName: string,
  opts: { env?: Record<string, string> } = {},
): Promise<{ ok: boolean; error?: string }> {
  const target = namedAppTarget(appName);
  if (!target) {
    return process.platform === 'darwin' || process.platform === 'win32'
      ? { ok: false, error: `Could not find ${appName} on this device. Quit and reopen it to apply the connection.` }
      : { ok: false, error: `${appName} restart is not supported on this platform.` };
  }
  const result = await restartAppTarget(target, { force: true, launchIfStopped: true, env: opts.env });
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

/** A launch target for an app we only know by name. macOS addresses those
    through `open -a` / AppleScript, so the bare name is enough; Windows has no
    name-based launcher, so the name is resolved against installed apps to
    recover a real executable path.

    A profile's `restartAppName` may be the friendly Start Menu name or the
    executable's name — "Visual Studio Code" ships Code.exe — so when no entry
    name matches, entries are re-matched by their resolved executable's
    basename. That resolution reads each `.lnk` in turn, so it only runs on the
    miss path. */
export function namedAppTarget(appName: string): AppLaunchTarget | null {
  if (!appName) return null;
  if (process.platform === 'darwin') return { name: appName, path: '' };
  if (process.platform === 'win32') {
    const apps = cachedInstalledApplications();
    const wanted = appName.toLowerCase();
    const byName = apps.find((entry) => entry.name.toLowerCase() === wanted);
    if (byName) return byName;
    return apps.find((entry) => {
      const executable = windowsExecutablePath(entry.path);
      return executable !== null && path.basename(executable, '.exe').toLowerCase() === wanted;
    }) ?? null;
  }
  return null;
}

/** `listInstalledApplications` walks Start Menu shortcuts and program folders
    synchronously — cheap once, not per lookup. `restartConnectedApps` resolves
    a name per profile in a loop, so the scan is done once per run (matching
    the icon list's lifetime in `installedAppsPromise`). */
export let installedApplicationsCache: AppLaunchTarget[] | null = null;
export function cachedInstalledApplications(): AppLaunchTarget[] {
  if (installedApplicationsCache === null) {
    const listed = listInstalledApplications();
    // A failed scan stays uncached so a later call can retry.
    if (!listed.ok) return [];
    installedApplicationsCache = listed.apps;
  }
  return installedApplicationsCache;
}
