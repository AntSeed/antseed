import { readFile, writeFile, readdir, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow } from 'electron';
import type { AppendLogFn } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFileCallback);

export const DEFAULT_PLUGINS_DIR = path.join(homedir(), '.antseed', 'plugins');
const DEFAULT_PLUGINS_PACKAGE_JSON = path.join(DEFAULT_PLUGINS_DIR, 'package.json');
export const SAFE_PLUGIN_PACKAGE_PATTERN = /^(@?[a-z0-9][a-z0-9._-]*)(\/[a-z0-9][a-z0-9._-]*)?$/i;
export const PLUGIN_PACKAGE_ALIAS_MAP: Record<string, string> = {
  'local': '@antseed/router-local',
  'router-local': '@antseed/router-local',
  'antseed-router-local': '@antseed/router-local',
};
export const SCOPED_TO_LEGACY_PLUGIN_PACKAGE_MAP: Record<string, string> = {
  '@antseed/router-local': 'antseed-router-local',
};

export type InstalledPlugin = {
  package: string;
  version: string;
};

export interface EnsureDefaultPluginContext {
  getAppSetupNeeded: () => boolean;
  setAppSetupNeeded: (value: boolean) => void;
  getAppSetupComplete: () => boolean;
  setAppSetupComplete: (value: boolean) => void;
  getMainWindow: () => BrowserWindow | null;
  appendLog: AppendLogFn;
}

export function isSafePluginPackageName(value: string): boolean {
  return SAFE_PLUGIN_PACKAGE_PATTERN.test(value);
}

export function normalizePluginPackageName(value: string): string {
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

export function resolveLegacyPluginPackage(packageName: string): string | null {
  return SCOPED_TO_LEGACY_PLUGIN_PACKAGE_MAP[packageName] ?? null;
}

export function resolveLocalPackageNameAliases(packageName: string): Set<string> {
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

export function toFileInstallSpec(packageName: string, localPath: string): string {
  const normalizedPath = localPath.startsWith('file:') ? localPath.slice(5) : localPath;
  return `${packageName}@file:${normalizedPath}`;
}

export function toNpmAliasInstallSpec(packageName: string, legacyPackageName: string): string {
  return `${packageName}@npm:${legacyPackageName}`;
}

function packageNodeModulesPath(root: string, packageName: string): string {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

function bundledPackagePath(bundleRoot: string, packageName: string): string {
  return path.join(bundleRoot, ...packageName.split('/'));
}

async function readPackageVersion(packageDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(packageDir, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function ensurePluginsDirectory(): Promise<void> {
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

export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
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

interface NpmInvocation { bin: string; leadingArgs: string[] }

export function resolveNpmInvocation(): NpmInvocation {
  const envNpmExecPath = process.env['npm_execpath']?.trim();
  if (envNpmExecPath && existsSync(envNpmExecPath)) {
    return { bin: process.execPath, leadingArgs: [envNpmExecPath] };
  }

  // Electron apps often get a restricted PATH, so check common install
  // locations before falling back.
  const isWindows = process.platform === 'win32';
  const candidates = isWindows
    ? [
        path.join(path.dirname(process.execPath), 'npm.cmd'),
        path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'nodejs', 'npm.cmd'),
        path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', 'npm.cmd'),
        ...(process.env['APPDATA']
          ? [path.join(process.env['APPDATA'], 'npm', 'npm.cmd')]
          : []),
      ]
    : [
        path.join(path.dirname(process.execPath), 'npm'),
        '/usr/local/bin/npm',          // Homebrew (Intel Mac)
        '/opt/homebrew/bin/npm',       // Homebrew (Apple Silicon)
        '/usr/bin/npm',                // System
        path.join(homedir(), '.nvm', 'alias', 'default', 'bin', 'npm'), // nvm symlink
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { bin: candidate, leadingArgs: [] };
  }
  return { bin: 'npm', leadingArgs: [] }; // fallback — rely on PATH
}

let _appendLog: AppendLogFn = () => {};

export function setPluginAppendLog(fn: AppendLogFn): void {
  _appendLog = fn;
}

export async function installPluginDependency(packageSpec: string): Promise<void> {
  await ensurePluginsDirectory();
  const npm = resolveNpmInvocation();
  _appendLog('connect', 'system', `Installing "${packageSpec}" via ${npm.bin}...`);

  await execFileAsync(npm.bin, [...npm.leadingArgs, 'install', '--ignore-scripts', packageSpec], {
    cwd: DEFAULT_PLUGINS_DIR,
    timeout: 120_000, // 2-minute hard limit
    env: {
      ...process.env,
      PATH: [
        path.dirname(process.execPath),
        ...(process.platform === 'win32'
          ? [
              path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'nodejs'),
              path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs'),
              ...(process.env['APPDATA']
                ? [path.join(process.env['APPDATA'], 'npm')]
                : []),
            ]
          : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']),
        process.env['PATH'] ?? '',
      ].filter((segment) => segment.length > 0).join(path.delimiter),
    },
  });
}

export async function installPluginFromBundle(packageName: string): Promise<boolean> {
  // In production builds, plugins are bundled into Resources/bundled-plugins/.
  const bundleRoot = path.join(process.resourcesPath ?? '', 'bundled-plugins');
  if (!existsSync(bundledPackagePath(bundleRoot, packageName))) return false;

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
      await rm(dest, { recursive: true, force: true });
      await cp(src, dest, { recursive: true, force: true });
      _appendLog('connect', 'system', `Copied bundled plugin ${scope.name}/${pkg.name}.`);
    }
  }

  return existsSync(path.join(destRoot, ...packageName.split('/'), 'package.json'));
}

export function isPluginInstalled(packageName: string): boolean {
  const pluginDir = packageNodeModulesPath(DEFAULT_PLUGINS_DIR, packageName);
  return existsSync(path.join(pluginDir, 'package.json'))
    && existsSync(path.join(pluginDir, 'dist', 'index.js'));
}

export async function isBundledPluginRefreshNeeded(packageName: string): Promise<boolean> {
  const bundleRoot = path.join(process.resourcesPath ?? '', 'bundled-plugins');
  if (!existsSync(bundledPackagePath(bundleRoot, packageName))) return false;

  const bundleEntries = await readdir(bundleRoot, { withFileTypes: true });
  const scopeDirs = bundleEntries.filter((e) => e.isDirectory() && e.name.startsWith('@'));

  for (const scope of scopeDirs) {
    const pkgEntries = await readdir(path.join(bundleRoot, scope.name), { withFileTypes: true });
    for (const pkg of pkgEntries.filter((e) => e.isDirectory())) {
      const pkgName = `${scope.name}/${pkg.name}`;
      const bundledVersion = await readPackageVersion(bundledPackagePath(bundleRoot, pkgName));
      if (bundledVersion == null) continue;

      const installedVersion = await readPackageVersion(packageNodeModulesPath(DEFAULT_PLUGINS_DIR, pkgName));
      if (installedVersion !== bundledVersion) {
        return true;
      }
    }
  }

  return false;
}

export async function resolveLocalPluginSource(packageName: string): Promise<string | null> {
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

export async function ensureDefaultPlugin(
  packageName: string,
  ctx: EnsureDefaultPluginContext,
): Promise<void> {
  const installed = isPluginInstalled(packageName);
  const refreshFromBundle = installed ? await isBundledPluginRefreshNeeded(packageName) : false;
  if (installed && !refreshFromBundle) {
    ctx.setAppSetupNeeded(false);
    ctx.setAppSetupComplete(true);
    return;
  }
  ctx.setAppSetupNeeded(true);
  ctx.getMainWindow()?.webContents.send('app:setup-step', { step: 'installing', label: 'Installing router plugin' });
  ctx.appendLog(
    'connect',
    'system',
    refreshFromBundle
      ? `Refreshing bundled plugin "${packageName}".`
      : `Required plugin "${packageName}" not found. Installing`,
  );
  try {
    // 1. Try copying from the app bundle (production builds — instant, no network)
    const installedFromBundle = await installPluginFromBundle(packageName);
    if (installedFromBundle) {
      ctx.appendLog('connect', 'system', `Installed plugin "${packageName}" from app bundle.`);
    } else {
      // 2. Try local monorepo source (dev builds)
      const localSource = await resolveLocalPluginSource(packageName);
      ctx.appendLog('connect', 'system', localSource ? `Using local source: ${localSource}` : `Using npm registry (${resolveNpmInvocation().bin})...`);
      if (localSource) {
        await installPluginDependency(toFileInstallSpec(packageName, localSource));
      } else {
        // 3. Fall back to npm registry
        await installPluginDependency(packageName);
      }
    }
    ctx.appendLog('connect', 'system', `Installed plugin "${packageName}".`);
    ctx.setAppSetupComplete(true);
    ctx.getMainWindow()?.webContents.send('app:setup-step', { step: 'done', label: 'Router plugin ready' });
    ctx.getMainWindow()?.webContents.send('app:setup-complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.appendLog('connect', 'system', `Failed to auto-install plugin "${packageName}": ${message}`);
    ctx.getMainWindow()?.webContents.send('app:setup-step', { step: 'error', label: 'Failed to install router plugin' });
    // Do NOT emit app:setup-complete on failure — the onAppSetupComplete handler
    // would unconditionally start the connect process even though the plugin is
    // not available, producing a spurious "Buyer runtime exited unexpectedly" message.
    throw new Error(`Required plugin "${packageName}" could not be installed: ${message}`);
  }
}
