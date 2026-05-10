import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path, { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPluginsDir, installPlugin } from './manager.js'
import { TRUSTED_PLUGINS } from './registry.js'
import type { AntseedProviderPlugin, AntseedRouterPlugin, PluginConfigKey } from '@antseed/node'

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function resolvePackageName(nameOrPackage: string): string {
  const legacy = LEGACY_PACKAGE_MAP[nameOrPackage]
  if (legacy) return legacy
  const trusted = TRUSTED_PLUGINS.find(p => p.name === nameOrPackage)
  return trusted?.package ?? nameOrPackage
}

type PluginKind = 'provider' | 'router'

async function loadPlugin<T>(
  nameOrPackage: string,
  kind: PluginKind,
  methodName: keyof AntseedProviderPlugin | keyof AntseedRouterPlugin
): Promise<T> {
  const pkgName = resolvePackageName(nameOrPackage)
  const pluginsDir = getPluginsDir()
  const pluginPath = join(pluginsDir, 'node_modules', pkgName, 'dist', 'index.js')
  const resolved = path.resolve(pluginPath)
  if (!resolved.startsWith(path.resolve(pluginsDir))) {
    throw new Error(`Invalid plugin path: ${pkgName}`)
  }

  const isModuleNotFound = (err: unknown): boolean =>
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'

  const isTrusted = TRUSTED_PLUGINS.some(p => p.package === pkgName)
  if (isTrusted) {
    await ensureTrustedPluginInstallReady(pkgName, resolved, pluginsDir)
  }

  let mod: { default?: unknown }
  try {
    mod = await import(pathToFileURL(resolved).href) as { default?: unknown }
  } catch (err) {
    if (isModuleNotFound(err) && !existsSync(resolved)) {
      throw new Error(
        `Plugin "${pkgName}" not found. Install it first, then retry your command.\nRun: antseed plugin add ${pkgName}`
      )
    } else {
      const cause = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Plugin "${pkgName}" failed to load from ${resolved}.\nCause: ${cause}`
      )
    }
  }

  const plugin = mod.default
  if (!plugin || typeof plugin !== 'object' || (plugin as { type?: string }).type !== kind) {
    throw new Error(
      `Plugin "${pkgName}" does not export a valid ${kind} plugin (expected default export with type: '${kind}')`
    )
  }

  if (typeof (plugin as Record<string, unknown>)[methodName] !== 'function') {
    throw new Error(`Plugin "${pkgName}" does not implement ${methodName}()`)
  }

  return plugin as T
}

async function ensureTrustedPluginInstallReady(
  pkgName: string,
  entryPath: string,
  pluginsDir: string,
): Promise<void> {
  const pkgJsonPath = join(pluginsDir, 'node_modules', ...pkgName.split('/'), 'package.json')
  const shouldInstall = !existsSync(entryPath)
    || !existsSync(pkgJsonPath)
    || hasMissingDeclaredDependencyTree(pkgName, pluginsDir)
  if (!shouldInstall) return
  if (isTruthyEnv(process.env['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'])) return

  const action = existsSync(entryPath)
    ? 'appears incomplete or stale. Reinstalling latest version...'
    : 'not installed. Installing...'
  console.log(`Plugin "${pkgName}" ${action}`)
  try {
    await installPlugin(`${pkgName}@latest`)
  } catch (installErr) {
    const cause = installErr instanceof Error ? installErr.message : String(installErr)
    throw new Error(`Failed to install plugin "${pkgName}".\nCause: ${cause}`)
  }
}

function hasMissingDeclaredDependencyTree(
  pkgName: string,
  pluginsDir: string,
  visited: Set<string> = new Set(),
): boolean {
  if (visited.has(pkgName)) return false
  visited.add(pkgName)

  const pkgJsonPath = path.resolve(join(pluginsDir, 'node_modules', ...pkgName.split('/'), 'package.json'))
  if (!pkgJsonPath.startsWith(path.resolve(pluginsDir))) return true
  if (!existsSync(pkgJsonPath)) return true

  try {
    const raw = readFileSync(pkgJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      name?: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const manifestName = typeof parsed.name === 'string' ? parsed.name : pkgName
    const deps = {
      ...(parsed.dependencies ?? {}),
      ...(manifestName.startsWith('@antseed/') ? parsed.peerDependencies ?? {} : {}),
    }
    for (const depName of Object.keys(deps)) {
      if (NODE_BUILTINS.has(depName)) continue
      if (hasMissingDeclaredDependencyTree(depName, pluginsDir, visited)) return true
    }
    return false
  } catch {
    return true
  }
}

export async function loadProviderPlugin(nameOrPackage: string): Promise<AntseedProviderPlugin> {
  return loadPlugin<AntseedProviderPlugin>(nameOrPackage, 'provider', 'createProvider')
}

export async function loadRouterPlugin(nameOrPackage: string): Promise<AntseedRouterPlugin> {
  return loadPlugin<AntseedRouterPlugin>(nameOrPackage, 'router', 'createRouter')
}

export function buildPluginConfig(
  configKeys: PluginConfigKey[],
  runtimeOverrides?: Record<string, string>,
  instanceConfig?: Record<string, string>,
): Record<string, string> {
  const config: Record<string, string> = {}
  // Priority: instanceConfig (lowest) < env vars < runtime overrides (highest)
  if (instanceConfig) {
    Object.assign(config, instanceConfig)
  }
  for (const key of configKeys) {
    const value = process.env[key.key]
    if (value !== undefined) {
      config[key.key] = value
    }
  }
  if (runtimeOverrides) {
    Object.assign(config, runtimeOverrides)
  }
  return config
}

/**
 * Read the installed version of a package from the plugins directory.
 * Returns the version string or null if not found.
 */
function readPluginPackageVersion(pkgName: string): string | null {
  try {
    const pluginsDir = getPluginsDir()
    const pkgJsonPath = join(pluginsDir, 'node_modules', pkgName, 'package.json')
    const resolved = path.resolve(pkgJsonPath)
    if (!resolved.startsWith(path.resolve(pluginsDir))) {
      return null
    }
    const raw = readFileSync(resolved, 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/**
 * Returns version info for core packages and a named plugin.
 * Useful for startup logging.
 */
export function getPackageVersions(pluginName?: string): Record<string, string> {
  const versions: Record<string, string> = {}
  const corePackages = ['@antseed/node', '@antseed/provider-core', '@antseed/router-core']
  for (const pkg of corePackages) {
    const v = readPluginPackageVersion(pkg)
    if (v) versions[pkg] = v
  }
  if (pluginName) {
    const pkgName = resolvePackageName(pluginName)
    const v = readPluginPackageVersion(pkgName)
    if (v) versions[pkgName] = v
  }
  return versions
}

/** Map legacy package names to current names */
export const LEGACY_PACKAGE_MAP: Record<string, string> = {
  'antseed-provider-anthropic': '@antseed/provider-anthropic',
  'antseed-router-claude-code': '@antseed/router-local',
}
