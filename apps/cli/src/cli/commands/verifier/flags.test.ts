import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePositiveIntFlag, resolveReferenceUpstreamInput } from './flags.js'
import { resolveUpstream } from '../../../verifier/reference-builder.js'

test('parsePositiveIntFlag accepts positive integers', () => {
  assert.equal(parsePositiveIntFlag('1'), 1)
  assert.equal(parsePositiveIntFlag('300000'), 300000)
  assert.equal(parsePositiveIntFlag(' 42 '), 42)
})

test('parsePositiveIntFlag rejects garbage that parseInt silently accepted', () => {
  // "5m" previously became NaN → setTimeout(NaN) → zero-delay audit loop.
  assert.throws(() => parsePositiveIntFlag('5m'), /positive integer/)
  assert.throws(() => parsePositiveIntFlag('abc'), /positive integer/)
  assert.throws(() => parsePositiveIntFlag(''), /positive integer/)
  assert.throws(() => parsePositiveIntFlag('0'), /positive integer/)
  assert.throws(() => parsePositiveIntFlag('-5'), /positive integer/)
  assert.throws(() => parsePositiveIntFlag('1.5'), /positive integer/)
})

test('--api-key beats a configured apiKeyEnv end-to-end', () => {
  process.env['ANTSEED_TEST_REF_KEY'] = 'from-env'
  try {
    const input = resolveReferenceUpstreamInput(
      { apiKey: 'from-flag' },
      { baseUrl: 'https://u/v1', apiKeyEnv: 'ANTSEED_TEST_REF_KEY' },
    )
    // The config env indirection must not survive into the resolved input…
    assert.deepEqual(input, { baseUrl: 'https://u/v1', apiKey: 'from-flag' })
    // …so resolveUpstream bills the account the operator named on the CLI.
    assert.deepEqual(resolveUpstream(input), { baseUrl: 'https://u/v1', apiKey: 'from-flag' })
  } finally {
    delete process.env['ANTSEED_TEST_REF_KEY']
  }
})

test('--api-key-env beats a configured apiKey', () => {
  process.env['ANTSEED_TEST_REF_KEY'] = 'from-flag-env'
  try {
    const input = resolveReferenceUpstreamInput(
      { apiKeyEnv: 'ANTSEED_TEST_REF_KEY' },
      { baseUrl: 'https://u/v1', apiKey: 'from-config' },
    )
    assert.deepEqual(resolveUpstream(input), { baseUrl: 'https://u/v1', apiKey: 'from-flag-env' })
  } finally {
    delete process.env['ANTSEED_TEST_REF_KEY']
  }
})

test('config values apply when no flags are given, --base-url overrides', () => {
  const fromConfig = resolveReferenceUpstreamInput(
    {},
    { baseUrl: 'https://config/v1', apiKey: 'config-key' },
  )
  assert.deepEqual(fromConfig, { baseUrl: 'https://config/v1', apiKey: 'config-key' })

  const overridden = resolveReferenceUpstreamInput(
    { baseUrl: 'https://flag/v1' },
    { baseUrl: 'https://config/v1', apiKey: 'config-key' },
  )
  assert.equal(overridden.baseUrl, 'https://flag/v1')
  assert.equal(overridden.apiKey, 'config-key')
})
