import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Per-app launch overrides for the Connected apps screen: the installed
 * application the user picked to represent a tool profile ("Open with").
 * Persists as `<data-dir>/app-launch.json` — a map of profile name to the
 * chosen application ({ name, path }): a `.app` bundle path on macOS, a
 * Start Menu `.lnk` shortcut path on Windows. An override wins over the
 * profile's packaged open action (openUrl / restartAppName) when launching.
 */

export type AppLaunchTarget = { name: string; path: string };

const APP_LAUNCH_FILE = 'app-launch.json';

export function loadAppLaunchSettings(dataDir: string): Record<string, AppLaunchTarget> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, APP_LAUNCH_FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const settings: Record<string, AppLaunchTarget> = {};
    for (const [profileName, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record['name'] === 'string' && record['name'].length > 0
        && typeof record['path'] === 'string' && record['path'].length > 0) {
        settings[profileName] = { name: record['name'], path: record['path'] };
      }
    }
    return settings;
  } catch {
    return {}; // first run or unreadable file — no overrides
  }
}

export function setAppLaunchSetting(dataDir: string, profileName: string, target: AppLaunchTarget | null): void {
  const settings = loadAppLaunchSettings(dataDir);
  if (target) settings[profileName] = target;
  else delete settings[profileName];
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, APP_LAUNCH_FILE), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/**
 * Per-app client-identity overrides: the client names (User-Agent product /
 * session-header slugs, e.g. 'opencode', 'tool-cli') that attribute wire
 * requests to an app profile. Persists as `<data-dir>/app-identity.json` —
 * a map of profile name to slug list. Absence means the profile's packaged
 * defaults apply.
 */

const APP_IDENTITY_FILE = 'app-identity.json';
const MAX_TOOL_SLUGS = 8;
const MAX_TOOL_SLUG_LENGTH = 64;

/** Normalize a user-entered client name the same way the buyer proxy slugs
    the wire identity (lowercase, non-alphanumeric runs collapse to `-`). */
export function normalizeToolSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Normalize a slug list: slugify, drop empties/dupes, cap count and length. */
export function normalizeToolSlugs(values: readonly string[]): string[] {
  const slugs: string[] = [];
  for (const value of values) {
    const slug = normalizeToolSlug(value).slice(0, MAX_TOOL_SLUG_LENGTH);
    if (slug && !slugs.includes(slug)) slugs.push(slug);
    if (slugs.length >= MAX_TOOL_SLUGS) break;
  }
  return slugs;
}

export function loadAppIdentitySettings(dataDir: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, APP_IDENTITY_FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const settings: Record<string, string[]> = {};
    for (const [profileName, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const slugs = normalizeToolSlugs(value.filter((entry): entry is string => typeof entry === 'string'));
      if (slugs.length > 0) settings[profileName] = slugs;
    }
    return settings;
  } catch {
    return {}; // first run or unreadable file — no overrides
  }
}

export function setAppIdentitySetting(dataDir: string, profileName: string, toolSlugs: readonly string[] | null): void {
  const settings = loadAppIdentitySettings(dataDir);
  const slugs = toolSlugs ? normalizeToolSlugs(toolSlugs) : [];
  if (slugs.length > 0) settings[profileName] = slugs;
  else delete settings[profileName];
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, APP_IDENTITY_FILE), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
