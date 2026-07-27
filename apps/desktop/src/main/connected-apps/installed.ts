/**
 * Enumerating the applications a user can attach to an app profile
 * ("Open with"), and launching one.
 *
 * macOS: `.app` bundles in the standard application folders. Windows: Start
 * Menu shortcuts (per-machine and per-user) plus Store/MSIX packages, which
 * only the Start menu enumeration sees.
 */
import { app, nativeImage, shell } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AppLaunchTarget } from './launch-settings.js';
import { appsFolderPath, isAppsFolderTarget, parseStartApps } from './windows-start-menu.js';

// Installed applications the user can associate with an app profile ("Open
// with"). macOS: .app bundles in the standard application folders. Windows:
// Start Menu shortcuts (per-machine and per-user).
/**
 * Apps as the Start menu lists them, which is the only enumeration that
 * includes Store / MSIX packages. Best-effort: on any failure the filesystem
 * scans still stand on their own, so the picker degrades to what it showed
 * before rather than coming back empty.
 */
export function listWindowsStartApps(): ReturnType<typeof parseStartApps> {
  try {
    const stdout = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Runs on the main process, so it blocks the UI: bounded well below the
      // point a user would call the app hung. Overshooting just costs the
      // packaged apps this run, and the scan is cached for the rest of it.
      timeout: 8_000,
      // Without this the PowerShell console flashes up over the app.
      windowsHide: true,
    });
    return parseStartApps(stdout);
  } catch {
    return [];
  }
}

export function listInstalledApplications(): { ok: boolean; apps: AppLaunchTarget[]; error?: string } {
  const apps = new Map<string, AppLaunchTarget>();
  if (process.platform === 'darwin') {
    for (const dir of ['/Applications', path.join(homedir(), 'Applications'), '/System/Applications']) {
      try {
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith('.app') || entry.startsWith('.')) continue;
          const name = entry.slice(0, -'.app'.length);
          if (!apps.has(name)) apps.set(name, { name, path: path.join(dir, entry) });
        }
      } catch { /* folder missing — skip */ }
    }
  } else if (process.platform === 'win32') {
    const programData = process.env['ProgramData'];
    const appData = process.env['APPDATA'];
    const shortcutRoots = [
      programData ? path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
      appData ? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    ].filter((root): root is string => root !== null);
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.toLowerCase().endsWith('.lnk')) {
          const name = entry.name.slice(0, -'.lnk'.length);
          if (!apps.has(name)) apps.set(name, { name, path: full });
        }
      }
    };
    for (const root of shortcutRoots) walk(root, 0);

    // Many per-user tool installs (VS Code, Cursor, Windsurf, ...) live under
    // %LOCALAPPDATA%\Programs\<App>\<App>.exe without ever registering a
    // Start Menu shortcut (e.g. a silent install, or "don't create a start
    // menu entry" during setup) — those are invisible to the scan above.
    // %ProgramFiles% installs normally DO get a Start Menu shortcut, but not
    // always, so it's scanned too, one level deep, to stay fast and avoid
    // picking up bundled helper binaries (updaters, crash handlers, uninstallers).
    const localAppData = process.env['LOCALAPPDATA'];
    const exeRoots = [
      localAppData ? path.join(localAppData, 'Programs') : null,
      process.env['ProgramFiles'] ?? null,
      process.env['ProgramFiles(x86)'] ?? null,
    ].filter((root): root is string => root !== null);
    const noiseNamePattern = /^(unins|uninstall|setup|update|updater|crashpad|vc_redist)/i;
    for (const root of exeRoots) {
      let appDirs;
      try {
        appDirs = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const appDir of appDirs) {
        if (!appDir.isDirectory()) continue;
        let files;
        try {
          files = readdirSync(path.join(root, appDir.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.isDirectory() || !file.name.toLowerCase().endsWith('.exe')) continue;
          const name = file.name.slice(0, -'.exe'.length);
          if (noiseNamePattern.test(name) || apps.has(name)) continue;
          apps.set(name, { name, path: path.join(root, appDir.name, file.name) });
        }
      }
    }

    // Last, so a real file path always wins: Microsoft Store / MSIX apps are
    // invisible to both scans above — they live under %ProgramFiles%\
    // WindowsApps (ACL-locked, and not a root we walk) and get no Start Menu
    // .lnk, because the Start menu renders them from their package manifest.
    // Claude for Windows ships this way, so it never appeared in the picker
    // at all. These entries are addressed by AppUserModelID instead of path.
    for (const entry of listWindowsStartApps()) {
      if (apps.has(entry.name)) continue;
      apps.set(entry.name, { name: entry.name, path: appsFolderPath(entry.appId) });
    }
  } else {
    return { ok: false, apps: [], error: 'Listing installed apps is not supported on this platform.' };
  }
  return { ok: true, apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

// Icons are extracted per entry — on macOS via the QuickLook thumbnail
// (app.getFileIcon returns the same generic icon for every .app bundle); on
// Windows, app.getFileIcon resolves icons weakly for .lnk shortcuts (it's
// built for real files), so shortcuts are first resolved to their target
// .exe. A few hundred lookups, so the enriched list is computed once per
// run and cached.
export async function installedAppIcon(entryPath: string): Promise<string | null> {
  // A packaged app has no file to extract an icon from; the renderer draws
  // its brand mark instead.
  if (isAppsFolderTarget(entryPath)) return null;
  try {
    if (process.platform === 'darwin') {
      const icon = await nativeImage.createThumbnailFromPath(entryPath, { width: 48, height: 48 });
      return icon.isEmpty() ? null : icon.toDataURL();
    }
    const icon = await app.getFileIcon(windowsIconSourcePath(entryPath), { size: 'normal' });
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch {
    return null; // no icon — the renderer falls back to a brand mark
  }
}

/** Resolves a Start Menu `.lnk` shortcut to its target executable, which
    `app.getFileIcon` extracts an icon from far more reliably than the
    shortcut file itself. Falls back to the shortcut path if it isn't a
    `.lnk`, or the target can't be read. No-op on non-Windows platforms. */
export function windowsIconSourcePath(entryPath: string): string {
  if (process.platform !== 'win32' || !entryPath.toLowerCase().endsWith('.lnk')) return entryPath;
  try {
    const target = shell.readShortcutLink(entryPath).target;
    return target && existsSync(target) ? target : entryPath;
  } catch {
    return entryPath;
  }
}


/** Launch a user-picked application target (.app bundle / .lnk shortcut). */
export function launchAppTarget(target: AppLaunchTarget): { ok: boolean; error?: string } {
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [target.path], { stdio: 'pipe' });
      return { ok: true };
    }
    if (process.platform === 'win32') {
      // A packaged app has no path to start — it is addressed by
      // AppUserModelID, and explorer is what resolves those.
      const child = isAppsFolderTarget(target.path)
        ? spawn('explorer.exe', [target.path], { detached: true, stdio: 'ignore' })
        : spawn('cmd.exe', ['/c', 'start', '', target.path], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    }
    return { ok: false, error: 'Launching apps is not supported on this platform.' };
  } catch {
    return { ok: false, error: `Could not open ${target.name} — is it still installed?` };
  }
}

/**
 * The picker's list, with icons, resolved once per app run. Icon extraction
 * shells out per entry, so this is memoized rather than recomputed on every
 * open of the picker.
 */
let installedAppsPromise: Promise<{ ok: boolean; apps: Array<AppLaunchTarget & { iconDataUri?: string }>; error?: string }> | null = null;

export function listInstalledAppsWithIcons(): Promise<{ ok: boolean; apps: Array<AppLaunchTarget & { iconDataUri?: string }>; error?: string }> {
  installedAppsPromise ??= (async () => {
    const listed = listInstalledApplications();
    if (!listed.ok) return listed;
    const apps = await Promise.all(listed.apps.map(async (entry) => {
      const iconDataUri = await installedAppIcon(entry.path);
      return iconDataUri ? { ...entry, iconDataUri } : entry;
    }));
    return { ok: true, apps };
  })();
  return installedAppsPromise;
}
