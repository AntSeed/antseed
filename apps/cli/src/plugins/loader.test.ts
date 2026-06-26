import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertPinnedPluginVersion } from './loader.js'

function withPluginVersion(pkgName: string, version: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-loader-test-'))
  try {
    const pkgDir = join(dir, 'node_modules', ...pkgName.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version }), 'utf-8')
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('assertPinnedPluginVersion accepts the locked verifier version', () => {
  withPluginVersion('@refoundhq/antseed-verifier', '0.1.0', (dir) => {
    assert.doesNotThrow(() => assertPinnedPluginVersion('@refoundhq/antseed-verifier', dir))
  })
})

test('assertPinnedPluginVersion rejects a mismatched verifier version', () => {
  withPluginVersion('@refoundhq/antseed-verifier', '0.1.1', (dir) => {
    assert.throws(
      () => assertPinnedPluginVersion('@refoundhq/antseed-verifier', dir),
      /version-locked to 0\.1\.0/,
    )
  })
})

test('assertPinnedPluginVersion ignores unpinned trusted packages', () => {
  withPluginVersion('@antseed/provider-openai', '999.0.0', (dir) => {
    assert.doesNotThrow(() => assertPinnedPluginVersion('@antseed/provider-openai', dir))
  })
})
