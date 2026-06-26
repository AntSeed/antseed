import assert from 'node:assert/strict'
import test from 'node:test'
import { TRUSTED_PLUGINS, resolvePluginPackage } from './registry.js'

test('curated verifier pins an exact package version', () => {
  const verifiers = TRUSTED_PLUGINS.filter((p) => p.type === 'verifier')
  assert.ok(verifiers.length > 0, 'expected a curated verifier')
  for (const v of verifiers) {
    assert.match(v.version ?? '', /^\d+\.\d+\.\d+/, `verifier ${v.name} must pin a locked binary version`)
  }
})

test('providers are not version-pinned', () => {
  assert.ok(TRUSTED_PLUGINS.filter((p) => p.type === 'provider').every((p) => !p.version))
})

test('noop verifier is not curated', () => {
  assert.equal(TRUSTED_PLUGINS.some((p) => p.name === 'antseed/noop' || p.package === '@antseed/verifier-noop'), false)
})

test('verifier id resolves to its package (short name, not id=package)', () => {
  assert.equal(resolvePluginPackage('refoundhq-antseed-verifier'), '@refoundhq/antseed-verifier')
})
