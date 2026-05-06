import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectPluginDrift,
  ensurePluginsUpToDate,
  getCliBundledVersion,
  getPluginPinnedCoreVersion,
  type RefreshResult,
} from './drift.js'

/**
 * Build a fake plugins dir on disk, populated with the given plugins and
 * their `dependencies` maps. Returns the temp dir; caller is responsible
 * for cleanup via `rmSync(dir, { recursive: true, force: true })`.
 */
function makeFakePluginsDir(plugins: Record<string, { version: string; dependencies?: Record<string, string> }>): string {
  const root = mkdtempSync(join(tmpdir(), 'antseed-drift-test-'))
  for (const [name, spec] of Object.entries(plugins)) {
    const pluginDir = join(root, 'node_modules', ...name.split('/'))
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name, version: spec.version, dependencies: spec.dependencies ?? {} }, null, 2),
      'utf-8',
    )
  }
  return root
}

test('getCliBundledVersion returns the version of a package bundled with the CLI', () => {
  // chalk is a real dependency of the CLI and will resolve from this package's
  // node_modules. We only assert it's a non-empty string — the exact value
  // varies with the lockfile.
  const v = getCliBundledVersion('chalk')
  assert.equal(typeof v, 'string')
  assert.ok((v ?? '').length > 0, 'chalk should resolve to a non-empty version string')
})

test('getCliBundledVersion returns null for a package that is not bundled', () => {
  const v = getCliBundledVersion('@definitely-not-a-real-package/this-cannot-exist-12345')
  assert.equal(v, null)
})

test('getPluginPinnedCoreVersion reads the pinned dep from the plugin package.json', () => {
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.40',
      dependencies: { '@antseed/provider-core': '0.2.48' },
    },
  })
  try {
    assert.equal(
      getPluginPinnedCoreVersion('@antseed/provider-openai', '@antseed/provider-core', root),
      '0.2.48',
    )
    assert.equal(
      getPluginPinnedCoreVersion('@antseed/provider-openai', '@antseed/node', root),
      null,
      'should return null when the plugin does not depend on the core package at all',
    )
    assert.equal(
      getPluginPinnedCoreVersion('@antseed/not-installed', '@antseed/provider-core', root),
      null,
      'should return null when the plugin is not installed',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('getPluginPinnedCoreVersion refuses paths that escape the plugins dir', () => {
  // Even with a malicious plugin name containing path separators, the function
  // must NOT read files outside the supplied plugins dir.
  const root = mkdtempSync(join(tmpdir(), 'antseed-drift-test-'))
  try {
    // No file is created; we only need to confirm we get null (not a throw,
    // not an external file read).
    const malicious = getPluginPinnedCoreVersion('../../../../etc/passwd', '@antseed/provider-core', root)
    assert.equal(malicious, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectPluginDrift flags plugins whose pinned core deps differ from CLI-bundled versions', () => {
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.40',
      dependencies: { '@antseed/provider-core': '0.2.48' }, // STALE
    },
    '@antseed/provider-anthropic': {
      version: '0.1.42',
      dependencies: { '@antseed/provider-core': '0.2.49' }, // current
    },
  })
  try {
    const report = detectPluginDrift(
      ['@antseed/provider-openai', '@antseed/provider-anthropic'],
      root,
      { '@antseed/provider-core': '0.2.49', '@antseed/node': null, '@antseed/router-core': null, '@antseed/api-adapter': null },
    )
    assert.equal(report.driftedPlugins.length, 1)
    assert.equal(report.driftedPlugins[0]!.plugin, '@antseed/provider-openai')
    assert.equal(report.driftedPlugins[0]!.staleCorePackages.length, 1)
    assert.equal(report.driftedPlugins[0]!.staleCorePackages[0]!.pkg, '@antseed/provider-core')
    assert.equal(report.driftedPlugins[0]!.staleCorePackages[0]!.pluginPinnedVersion, '0.2.48')
    assert.equal(report.driftedPlugins[0]!.staleCorePackages[0]!.cliBundledVersion, '0.2.49')
    assert.equal(report.missingPlugins.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectPluginDrift reports missing plugins separately from drifted plugins', () => {
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.41',
      dependencies: { '@antseed/provider-core': '0.2.49' },
    },
  })
  try {
    const report = detectPluginDrift(
      ['@antseed/provider-openai', '@antseed/provider-anthropic'],
      root,
      { '@antseed/provider-core': '0.2.49', '@antseed/node': null, '@antseed/router-core': null, '@antseed/api-adapter': null },
    )
    assert.deepEqual(report.driftedPlugins, [])
    assert.deepEqual(report.missingPlugins, ['@antseed/provider-anthropic'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectPluginDrift treats a plugin pin newer than the CLI bundle as drift too', () => {
  // This is intentional: a newer plugin pin means the plugin was built
  // against a core API the CLI may not yet ship. We surface that so the
  // operator can decide whether to upgrade the CLI or hold back the plugin.
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.99',
      dependencies: { '@antseed/provider-core': '0.3.0' }, // newer than bundled
    },
  })
  try {
    const report = detectPluginDrift(
      ['@antseed/provider-openai'],
      root,
      { '@antseed/provider-core': '0.2.49', '@antseed/node': null, '@antseed/router-core': null, '@antseed/api-adapter': null },
    )
    assert.equal(report.driftedPlugins.length, 1)
    assert.equal(report.driftedPlugins[0]!.staleCorePackages[0]!.pluginPinnedVersion, '0.3.0')
    assert.equal(report.driftedPlugins[0]!.staleCorePackages[0]!.cliBundledVersion, '0.2.49')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectPluginDrift ignores core packages the CLI does not bundle', () => {
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.40',
      dependencies: { '@antseed/provider-core': '0.2.48', '@antseed/router-core': '0.1.0' },
    },
  })
  try {
    // CLI bundles provider-core but NOT router-core. We should only complain
    // about provider-core.
    const report = detectPluginDrift(
      ['@antseed/provider-openai'],
      root,
      { '@antseed/provider-core': '0.2.49', '@antseed/node': null, '@antseed/router-core': null, '@antseed/api-adapter': null },
    )
    assert.equal(report.driftedPlugins.length, 1)
    assert.equal(report.driftedPlugins[0]!.staleCorePackages.length, 1)
    assert.equal(report.driftedPlugins[0]!.staleCorePackages[0]!.pkg, '@antseed/provider-core')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensurePluginsUpToDate is a no-op when no plugins are passed', async () => {
  let refreshCalls = 0
  await ensurePluginsUpToDate([], {
    log: () => {},
    warn: () => {},
    refresh: async () => { refreshCalls += 1; return { refreshed: [], failed: [] } },
  })
  assert.equal(refreshCalls, 0)
})

test('ensurePluginsUpToDate skips when ANTSEED_SKIP_PLUGIN_UPDATE_CHECK=1', async () => {
  let refreshCalls = 0
  await ensurePluginsUpToDate(['@antseed/provider-openai'], {
    log: () => {},
    warn: () => {},
    refresh: async () => { refreshCalls += 1; return { refreshed: [], failed: [] } },
    env: { ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1' },
  })
  assert.equal(refreshCalls, 0)
})

test('ensurePluginsUpToDate skips third-party (non-trusted) plugins', async () => {
  // Even if a non-trusted plugin is drifted, we don't auto-update it.
  const root = makeFakePluginsDir({
    '@third-party/some-plugin': {
      version: '1.0.0',
      dependencies: { '@antseed/provider-core': '0.2.48' },
    },
  })
  try {
    let refreshCalls = 0
    const logs: string[] = []
    await ensurePluginsUpToDate(['@third-party/some-plugin'], {
      log: (m) => logs.push(m),
      warn: () => {},
      refresh: async () => { refreshCalls += 1; return { refreshed: [], failed: [] } },
      pluginsDir: root,
      bundledVersions: { '@antseed/provider-core': '0.2.49' },
    })
    assert.equal(refreshCalls, 0)
    assert.ok(
      logs.some((l) => l.includes('non-trusted')),
      `expected a non-trusted notice in logs, got: ${JSON.stringify(logs)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensurePluginsUpToDate is silent on the happy path (no drift, no missing)', async () => {
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.41',
      dependencies: { '@antseed/provider-core': '0.2.49' },
    },
  })
  try {
    let refreshCalls = 0
    const logs: string[] = []
    const warns: string[] = []
    await ensurePluginsUpToDate(['@antseed/provider-openai'], {
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
      refresh: async () => { refreshCalls += 1; return { refreshed: [], failed: [] } },
      pluginsDir: root,
      bundledVersions: { '@antseed/provider-core': '0.2.49' },
    })
    assert.equal(refreshCalls, 0, 'should not call refresh when no drift')
    assert.equal(logs.length, 0, `expected no logs on happy path, got: ${JSON.stringify(logs)}`)
    assert.equal(warns.length, 0, `expected no warnings on happy path, got: ${JSON.stringify(warns)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensurePluginsUpToDate triggers refresh on drift and reports success', async () => {
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.40',
      dependencies: { '@antseed/provider-core': '0.2.48' }, // stale
    },
  })
  try {
    const refreshCalls: string[][] = []
    const logs: string[] = []
    await ensurePluginsUpToDate(['@antseed/provider-openai'], {
      log: (m) => logs.push(m),
      warn: () => {},
      refresh: async (plugins) => {
        refreshCalls.push(plugins)
        return { refreshed: plugins, failed: [] } satisfies RefreshResult
      },
      pluginsDir: root,
      bundledVersions: { '@antseed/provider-core': '0.2.49' },
    })
    assert.deepEqual(refreshCalls, [['@antseed/provider-openai']])
    // Should mention the drift detection and the successful refresh.
    assert.ok(logs.some((l) => l.includes('stale')), `expected drift warning, got: ${JSON.stringify(logs)}`)
    assert.ok(logs.some((l) => l.includes('Refreshed')), `expected success message, got: ${JSON.stringify(logs)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensurePluginsUpToDate logs a manual-retry hint and continues when refresh fails', async () => {
  const root = makeFakePluginsDir({
    '@antseed/provider-openai': {
      version: '0.2.40',
      dependencies: { '@antseed/provider-core': '0.2.48' },
    },
  })
  try {
    const warns: string[] = []
    const logs: string[] = []
    await ensurePluginsUpToDate(['@antseed/provider-openai'], {
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
      refresh: async (plugins) => ({
        refreshed: [],
        failed: plugins.map((p) => ({ plugin: p, reason: 'simulated EAI_AGAIN' })),
      }),
      pluginsDir: root,
      bundledVersions: { '@antseed/provider-core': '0.2.49' },
    })
    assert.ok(
      warns.some((w) => w.includes('Failed to refresh @antseed/provider-openai') && w.includes('EAI_AGAIN')),
      `expected per-plugin failure warning, got: ${JSON.stringify(warns)}`,
    )
    assert.ok(
      warns.some((w) => w.includes('Continuing startup')),
      `expected continuation reassurance, got: ${JSON.stringify(warns)}`,
    )
    assert.ok(
      warns.some((w) => w.includes('npm install')),
      `expected manual-retry hint, got: ${JSON.stringify(warns)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
