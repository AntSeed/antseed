/**
 * Plugin drift detection and auto-refresh.
 *
 * Background
 * ----------
 * The CLI ships with a known-good copy of `@antseed/provider-core` (and other
 * shared packages) inside its own `node_modules`. Each installed plugin in
 * `~/.antseed/plugins/node_modules/<pkg>/` has its OWN pinned version of
 * `@antseed/provider-core` (because plugin `package.json`s use `workspace:*`
 * during development, which pnpm/npm publish rewrites to an exact version).
 *
 * When a user runs `npm i -g @antseed/cli@latest`, the CLI's bundled
 * `provider-core` updates — but the plugins in `~/.antseed/plugins/` do NOT.
 * They keep their original pin, so plugin code keeps importing the OLD
 * `provider-core` even though the CLI itself has the new one.
 *
 * This caused real production damage: a fix to the seller-side request
 * relay (`stream_options.include_usage` injection) shipped in
 * `@antseed/provider-core@0.2.49`, but sellers running the upgraded CLI
 * were still importing `provider-core@0.2.48` from their plugins dir. The
 * fix never took effect for them.
 *
 * What this module does
 * ---------------------
 * 1. Read the version of each `@antseed/*` core package the CLI itself
 *    bundles (the "expected" version).
 * 2. Read the version each installed trusted plugin has pinned in its own
 *    `package.json` `dependencies` map (the "actual" version).
 * 3. If any plugin pins a stale core version, run `npm install <plugin>@latest`
 *    in `~/.antseed/plugins/` for each affected plugin. That naturally pulls
 *    in the matching core version because workspace pinning is exact.
 *
 * The check is best-effort: any failure (network down, registry 5xx, npm
 * timeout, permission denied) logs a warning and lets startup continue with
 * the existing (possibly stale) plugins. We never block startup on registry
 * health.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import { getPluginsDir } from './manager.js'
import { TRUSTED_PLUGINS } from './registry.js'

const execFileAsync = promisify(execFile)

/** Core packages whose drift between CLI-bundled and plugin-pinned versions matters. */
const TRACKED_CORE_PACKAGES = [
  '@antseed/provider-core',
  '@antseed/node',
  '@antseed/router-core',
  '@antseed/api-adapter',
] as const

/** Hard timeout for a single `npm install` invocation during auto-refresh. */
const NPM_INSTALL_TIMEOUT_MS = 60_000

const requireFromHere = createRequire(import.meta.url)

export interface PluginDrift {
  /** Plugin package name, e.g. `@antseed/provider-openai`. */
  plugin: string
  /** Core packages on which this plugin pins a stale version. */
  staleCorePackages: Array<{
    pkg: string
    pluginPinnedVersion: string
    cliBundledVersion: string
  }>
}

export interface DriftReport {
  /** Plugins whose pinned core deps lag behind what the CLI itself bundles. */
  driftedPlugins: PluginDrift[]
  /** Plugins that were requested but are not installed in the plugins dir. */
  missingPlugins: string[]
}

export interface RefreshResult {
  /** Plugins that were successfully reinstalled at @latest. */
  refreshed: string[]
  /** Plugins where `npm install` failed; arr of `{plugin, reason}`. */
  failed: Array<{ plugin: string; reason: string }>
}

/**
 * Read the version of a package as bundled inside the CLI's own
 * `node_modules`. For `@antseed/*` packages, this is the version the CLI
 * was built against and the "source of truth" we want plugins to match.
 *
 * Resolution starts from this module's URL and walks up via Node's module
 * resolution, so it always finds the CLI's own bundled copy (not a hoisted
 * copy from elsewhere).
 *
 * Implementation note: many modern packages (e.g. chalk) declare `"exports"`
 * fields that block direct resolution of `<pkg>/package.json`. To handle
 * those, we first try `require.resolve('<pkg>/package.json')`, and on failure
 * fall back to resolving the package's main entry and walking up its parent
 * directories until we find a `package.json` whose `name` matches.
 *
 * Returns `null` if the package is not bundled with the CLI (which would be
 * a build-time error for `@antseed/*` deps, but we don't want to crash the
 * CLI over it at runtime).
 */
export function getCliBundledVersion(pkgName: string): string | null {
  // Fast path: works for any package whose `exports` allows reading
  // `package.json` directly (most packages, including all `@antseed/*` ones).
  try {
    const pkgJsonPath = requireFromHere.resolve(`${pkgName}/package.json`)
    return readVersionFromPackageJson(pkgJsonPath)
  } catch {
    // Fall through to the entry-point resolution path.
  }

  // Second fallback: search the standard Node `node_modules` lookup paths
  // directly for `<lookupPath>/<pkgName>/package.json`. This handles
  // workspace packages that have an `exports` field WITHOUT a default
  // resolvable entry (like @antseed/node, which only exposes named
  // subpaths) — those fail BOTH `resolve('<pkg>/package.json')` AND
  // `resolve('<pkg>')`, but the package.json is still on disk.
  const lookupPaths = (requireFromHere.resolve.paths(pkgName) ?? []) as string[]
  for (const dir of lookupPaths) {
    const candidate = join(dir, ...pkgName.split('/'), 'package.json')
    if (!existsSync(candidate)) continue
    const v = readVersionFromPackageJson(candidate)
    if (v) return v
  }

  // Third fallback: resolve the package's main entry and walk up to its
  // package.json. Last resort for unusual layouts.
  let entry: string
  try {
    entry = requireFromHere.resolve(pkgName)
  } catch {
    return null
  }
  let cur = entry
  for (let i = 0; i < 16; i += 1) {
    const parent = resolve(cur, '..')
    if (parent === cur) break
    cur = parent
    const candidate = join(cur, 'package.json')
    if (!existsSync(candidate)) continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: unknown; version?: unknown }
      if (parsed.name === pkgName && typeof parsed.version === 'string') {
        return parsed.version
      }
    } catch {
      // try next ancestor
    }
  }
  return null
}

function readVersionFromPackageJson(pkgJsonPath: string): string | null {
  try {
    const raw = readFileSync(pkgJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Read the version a given plugin pins for a given core package, by reading
 * the plugin's own `package.json` `dependencies` map.
 *
 * We deliberately do NOT use Node's module resolution here, because we want
 * the EXPECTED dependency version (what the plugin was built against) — not
 * the resolved/hoisted version (which may already be newer if another
 * plugin pulled it up). If the resolved version is newer than what this
 * plugin pins, the plugin is still effectively running on a newer core, but
 * it's a fragile state — the next reinstall could re-pin everything to a
 * mismatched version. So we treat "plugin's declared dep mismatches CLI
 * bundle" as drift even if the resolved version happens to match today.
 *
 * Returns `null` if the plugin is not installed, or if the plugin doesn't
 * declare this core package as a dependency at all (in which case there's
 * nothing to be drifted against).
 */
export function getPluginPinnedCoreVersion(
  pluginPackage: string,
  corePackage: string,
  pluginsDir: string = getPluginsDir(),
): string | null {
  const pluginPkgJsonPath = resolve(
    join(pluginsDir, 'node_modules', ...pluginPackage.split('/'), 'package.json'),
  )
  if (!existsSync(pluginPkgJsonPath)) return null

  // Defense in depth: refuse to read outside the plugins dir even if a
  // mischievous plugin name contains `..`. This mirrors the same check
  // loader.ts performs before importing plugin code.
  if (!pluginPkgJsonPath.startsWith(resolve(pluginsDir))) return null

  try {
    const raw = readFileSync(pluginPkgJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const dep = parsed.dependencies?.[corePackage]
    if (typeof dep !== 'string' || dep.length === 0) return null
    return dep
  } catch {
    return null
  }
}

/**
 * Compare plugin-pinned core versions against CLI-bundled core versions and
 * report any drift.
 *
 * `pluginPackages` should be the set of plugins the seller/buyer is about to
 * load. We don't check plugins that aren't being used.
 *
 * "Drift" here means: the plugin's `dependencies[corePkg]` is a value that
 * is not equal to the CLI-bundled version of `corePkg`. We treat any
 * mismatch as drift — including, deliberately, the case where the plugin's
 * pinned version is NEWER than the CLI's bundled version. That's also a
 * fragile state (the plugin's importable surface may rely on APIs the CLI
 * doesn't yet provide), and the user should know.
 *
 * We compare strings exactly, not via semver. plugins published from this
 * monorepo have `workspace:*` deps rewritten to exact versions on publish,
 * so the dep value is always a bare version like `0.2.48`. Range deps
 * (`^0.2.0`, `~0.2.5`) are treated as drift unless they happen to literally
 * equal the bundled version string — that's by design, because we can't
 * tell from a range whether the resolved version is what we want, and
 * forcing a re-resolve via `npm install` is the safe default.
 */
export function detectPluginDrift(
  pluginPackages: string[],
  pluginsDir: string = getPluginsDir(),
  bundledVersions: Record<string, string | null> = computeBundledVersions(),
): DriftReport {
  const driftedPlugins: PluginDrift[] = []
  const missingPlugins: string[] = []

  for (const plugin of pluginPackages) {
    const pluginPkgJsonPath = resolve(
      join(pluginsDir, 'node_modules', ...plugin.split('/'), 'package.json'),
    )
    if (!existsSync(pluginPkgJsonPath)) {
      missingPlugins.push(plugin)
      continue
    }

    const stale: PluginDrift['staleCorePackages'] = []
    for (const corePkg of TRACKED_CORE_PACKAGES) {
      const cliVersion = bundledVersions[corePkg]
      if (!cliVersion) continue
      const pluginPin = getPluginPinnedCoreVersion(plugin, corePkg, pluginsDir)
      if (pluginPin == null) continue
      if (pluginPin !== cliVersion) {
        stale.push({ pkg: corePkg, pluginPinnedVersion: pluginPin, cliBundledVersion: cliVersion })
      }
    }
    if (stale.length > 0) {
      driftedPlugins.push({ plugin, staleCorePackages: stale })
    }
  }

  return { driftedPlugins, missingPlugins }
}

function computeBundledVersions(): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const pkg of TRACKED_CORE_PACKAGES) {
    out[pkg] = getCliBundledVersion(pkg)
  }
  return out
}

/**
 * Reinstall the given plugins at `@latest` to pull in fresh transitive deps
 * (notably the right `@antseed/provider-core` pin).
 *
 * Best-effort: each plugin is installed independently; one failure does not
 * abort the others. Each install has a 60-second timeout.
 *
 * SECURITY: only call this with plugins from the trusted-plugins registry
 * (or otherwise known-safe). We don't validate that here because the
 * caller is in a better position to enforce it; the typical caller is
 * `ensurePluginsUpToDate` below, which DOES enforce the trust list.
 */
export async function refreshPlugins(plugins: string[]): Promise<RefreshResult> {
  const refreshed: string[] = []
  const failed: Array<{ plugin: string; reason: string }> = []

  for (const plugin of plugins) {
    try {
      await execFileAsync(
        'npm',
        ['install', '--ignore-scripts', `${plugin}@latest`],
        { cwd: getPluginsDir(), timeout: NPM_INSTALL_TIMEOUT_MS },
      )
      refreshed.push(plugin)
    } catch (err) {
      const reason = err instanceof Error
        ? (err.message.split('\n').slice(0, 3).join(' / ') || err.name)
        : String(err)
      failed.push({ plugin, reason })
    }
  }

  return { refreshed, failed }
}

/**
 * Top-level helper: detect drift, log a summary, and (unless skipped) refresh
 * the drifted plugins.
 *
 * Designed to be called once at startup of `seller start` / `buyer start`,
 * BEFORE any plugin is dynamically imported. (Once imported, refreshing on
 * disk has no effect on the running process — Node has already cached the
 * old module.)
 *
 * Called with `pluginPackages = []` is a no-op.
 *
 * Env vars honored:
 *  - `ANTSEED_SKIP_PLUGIN_UPDATE_CHECK=1`: skip the entire drift check.
 *    Use this in air-gapped environments or CI where plugins are pre-baked.
 *
 * The function never throws on its own; refresh failures are logged and
 * swallowed. The only way it errors is if the `pluginPackages` list itself
 * triggers an internal logic bug.
 */
export async function ensurePluginsUpToDate(
  pluginPackages: string[],
  opts: {
    /** Override for tests. Defaults to console.log/console.warn. */
    log?: (msg: string) => void
    warn?: (msg: string) => void
    /** Override for tests. Defaults to `getPluginsDir()`. */
    pluginsDir?: string
    /** Override for tests so we don't actually shell out. */
    refresh?: (plugins: string[]) => Promise<RefreshResult>
    /** Override for tests so we don't read real CLI bundled versions. */
    bundledVersions?: Record<string, string | null>
    /** Override env var lookup for tests. */
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const env = opts.env ?? process.env

  if (pluginPackages.length === 0) return
  if (isTruthy(env['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'])) return

  // Restrict to the trusted plugin set. We do NOT auto-update third-party
  // plugins — those should be managed manually because their release
  // cadence and trust model are out of our hands.
  const trustedPackages = new Set(TRUSTED_PLUGINS.map((p) => p.package))
  const eligible = pluginPackages.filter((p) => trustedPackages.has(p))
  const skippedThirdParty = pluginPackages.filter((p) => !trustedPackages.has(p))
  if (skippedThirdParty.length > 0) {
    log(chalk.dim(
      `Skipping plugin drift check for non-trusted package(s): ${skippedThirdParty.join(', ')}`,
    ))
  }
  if (eligible.length === 0) return

  const report = detectPluginDrift(
    eligible,
    opts.pluginsDir ?? getPluginsDir(),
    opts.bundledVersions ?? computeBundledVersions(),
  )

  if (report.driftedPlugins.length === 0) {
    // Quiet on the happy path — the existing "Package versions:" log line
    // already surfaces what's installed.
    return
  }

  log(chalk.yellow('⚠  Detected stale plugin core dependencies:'))
  for (const drift of report.driftedPlugins) {
    log(chalk.yellow(`   ${drift.plugin}:`))
    for (const stale of drift.staleCorePackages) {
      log(chalk.yellow(
        `     ${stale.pkg}: plugin pins ${stale.pluginPinnedVersion}, CLI bundles ${stale.cliBundledVersion}`,
      ))
    }
  }
  log(chalk.dim('   Refreshing affected plugin(s) from npm…'))

  const refresh = opts.refresh ?? refreshPlugins
  const driftedPluginNames = report.driftedPlugins.map((d) => d.plugin)
  const result = await refresh(driftedPluginNames)

  if (result.refreshed.length > 0) {
    log(chalk.green(`✓ Refreshed plugin(s): ${result.refreshed.join(', ')}`))
  }
  if (result.failed.length > 0) {
    for (const f of result.failed) {
      warn(chalk.yellow(
        `   Failed to refresh ${f.plugin}: ${f.reason}`,
      ))
    }
    warn(chalk.yellow(
      `   Continuing startup with the previously-installed plugin version(s).`,
    ))
    warn(chalk.dim(
      `   To retry manually: cd ${getPluginsDir()} && npm install ${result.failed.map((f) => `${f.plugin}@latest`).join(' ')}`,
    ))
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

// Exported for tests / startup logging.
export { TRACKED_CORE_PACKAGES }
