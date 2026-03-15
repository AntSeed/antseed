import assert from 'node:assert/strict'
import test from 'node:test'
import { TRUSTED_PLUGINS } from '../../plugins/registry.js'
import { buildPluginConfig, LEGACY_PACKAGE_MAP } from '../../plugins/loader.js'

test('TRUSTED_PLUGINS contains 6 official plugins', () => {
  assert.equal(TRUSTED_PLUGINS.length, 6)
  const names = TRUSTED_PLUGINS.map(p => p.name)
  assert.ok(names.includes('anthropic'))
  assert.ok(names.includes('claude-code'))
  assert.ok(names.includes('claude-oauth'))
  assert.ok(names.includes('openai'))
  assert.ok(names.includes('local-llm'))
  assert.ok(names.includes('local'))
})

test('TRUSTED_PLUGINS all have scoped package names', () => {
  for (const plugin of TRUSTED_PLUGINS) {
    assert.ok(plugin.package.startsWith('@antseed/'), `${plugin.name} package should be scoped`)
  }
})

test('buildPluginConfig uses priority: instanceConfig < env < overrides', () => {
  const keys = [
    { key: 'API_KEY', label: 'API Key', type: 'string' as const },
    { key: 'MODEL', label: 'Model', type: 'string' as const },
  ]
  const instanceConfig = { API_KEY: 'from-instance', MODEL: 'from-instance' }
  const original = process.env['API_KEY']
  process.env['API_KEY'] = 'from-env'
  try {
    const result = buildPluginConfig(keys, { API_KEY: 'from-override' }, instanceConfig)
    assert.equal(result['API_KEY'], 'from-override')
    assert.equal(result['MODEL'], 'from-instance')
  } finally {
    if (original === undefined) {
      delete process.env['API_KEY']
    } else {
      process.env['API_KEY'] = original
    }
  }
})

test('buildPluginConfig works without instanceConfig (backwards compatible)', () => {
  const keys = [
    { key: 'TEST_KEY_COMPAT', label: 'Test', type: 'string' as const },
  ]
  const result = buildPluginConfig(keys, { TEST_KEY_COMPAT: 'override' })
  assert.equal(result['TEST_KEY_COMPAT'], 'override')
})

test('LEGACY_PACKAGE_MAP maps old names to scoped names', () => {
  assert.equal(LEGACY_PACKAGE_MAP['antseed-provider-anthropic'], '@antseed/provider-anthropic')
  assert.equal(LEGACY_PACKAGE_MAP['antseed-router-claude-code'], '@antseed/router-local')
})
