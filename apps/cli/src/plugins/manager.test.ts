import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePluginInstallError } from './manager.js'

test('normalizePluginInstallError explains when npm is unavailable', () => {
  const error = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
  const normalized = normalizePluginInstallError('@antseed/provider-openai', error)

  assert.match(normalized.message, /npm was not found/)
  assert.match(normalized.message, /Install Node\.js 20 or newer/)
  assert.match(normalized.message, /@antseed\/provider-openai/)
})

test('normalizePluginInstallError preserves other install failures', () => {
  const error = new Error('registry unavailable')
  assert.equal(normalizePluginInstallError('@antseed/provider-openai', error), error)
})
