import { readFileSync } from 'node:fs'
import path, { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPluginsDir } from './manager.js'
import { TRUSTED_PLUGINS } from './registry.js'
import type { AntseedProviderPlugin, AntseedRouterPlugin, PluginConfigKey } from '@antseed/node'

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

  let mod: { default?: unknown }
  try {
    mod = await import(pathToFileURL(resolved).href) as { default?: unknown }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error(
        `Plugin "${pkgName}" not found. Install it with:\n  antseed plugin add ${pkgName}`
      )
    }
    throw new Error(
      `Plugin "${pkgName}" failed to load from ${resolved}.\nCause: ${cause}`
    )
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
