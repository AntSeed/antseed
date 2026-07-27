/**
 * Enumerating Windows apps the filesystem scans can't see.
 *
 * `listInstalledApplications` finds apps two ways: Start Menu `.lnk`
 * shortcuts, and executables sitting directly in a program folder. Microsoft
 * Store / MSIX packages are invisible to both — they install under
 * `%ProgramFiles%\WindowsApps`, which is ACL-locked and not one of the roots
 * we walk, and they get no `.lnk`: the Start menu renders them from their
 * package manifest instead. So an app can be plainly installed, visible in
 * Settings and in Start, and still never appear in our picker.
 *
 * `Get-StartApps` is the documented way to list what the user actually sees
 * under Start > All apps, packaged and desktop alike, and it returns the
 * AppUserModelID that `shell:AppsFolder` launches by. The parsing lives here,
 * apart from the PowerShell call, so it stays testable.
 */

/** Prefix marking a launch target addressed by AppUserModelID rather than by
    a file path. `explorer.exe shell:AppsFolder\<AUMID>` launches those. */
export const APPS_FOLDER_PREFIX = 'shell:AppsFolder\\';

export interface StartApp {
  name: string;
  /** AppUserModelID, e.g. "AnthropicClaude_1a2b3c4d5e!App". */
  appId: string;
}

/**
 * An AppUserModelID is an opaque token. It reaches `explorer.exe` as a single
 * argv entry with no shell involved, so this is not injection defence -- it
 * rejects values that could not be an AUMID at all, on the grounds that
 * anything that odd means we misread the output. Dots, dashes, underscores and
 * the "!" separating package family name from app id are all legal in real
 * AUMIDs and are kept.
 */
const FORBIDDEN_APP_ID_CHARS = new Set([
  '"', "'", "`", "<", ">", "|", "&", "\\", "/",
]);

function isPlausibleAppId(appId: string): boolean {
  for (const char of appId) {
    const code = char.codePointAt(0) ?? 0;
    // Control characters and space: an AUMID has neither.
    if (code <= 0x20 || code === 0x7f) return false;
    if (FORBIDDEN_APP_ID_CHARS.has(char)) return false;
  }
  return true;
}

export function isAppsFolderTarget(targetPath: string): boolean {
  return targetPath.startsWith(APPS_FOLDER_PREFIX);
}

export function appsFolderPath(appId: string): string {
  return `${APPS_FOLDER_PREFIX}${appId}`;
}

/**
 * Parse `Get-StartApps | Select-Object Name,AppID | ConvertTo-Json`.
 *
 * ConvertTo-Json emits a bare object rather than a one-element array when the
 * pipeline yields a single item, so both shapes are accepted. Rows missing
 * either field, or carrying an AppID we would not put on a command line, are
 * dropped — a malformed row must not take the rest of the list with it.
 */
export function parseStartApps(stdout: string): StartApp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const apps: StartApp[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const name = typeof record['Name'] === 'string' ? record['Name'].trim() : '';
    const appId = typeof record['AppID'] === 'string' ? record['AppID'].trim() : '';
    if (!name || !appId || !isPlausibleAppId(appId)) continue;
    // Windows lists the same app more than once (a desktop shortcut plus its
    // packaged identity); first one wins, matching the caller's merge order.
    if (seen.has(appId)) continue;
    seen.add(appId);
    apps.push({ name, appId });
  }
  return apps;
}
