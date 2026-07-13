import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OFFICIAL_BOOTSTRAP_NODES } from '@antseed/node/discovery'
import { resolveVerifierBootstrapNodes } from './start.js'

test('custom bootstrap nodes MERGE with the official ones, never replace them', () => {
  const resolved = resolveVerifierBootstrapNodes(['1.2.3.4:6881'])
  for (const official of OFFICIAL_BOOTSTRAP_NODES) {
    assert.ok(
      resolved.some((n) => n.host === official.host && n.port === official.port),
      `official node ${official.host} must survive a custom bootstrap list`,
    )
  }
  assert.ok(resolved.some((n) => n.host === '1.2.3.4' && n.port === 6881))
})

test('no custom bootstrap nodes yields exactly the official set', () => {
  assert.deepEqual(
    resolveVerifierBootstrapNodes(undefined),
    OFFICIAL_BOOTSTRAP_NODES.map((n) => ({ host: n.host, port: n.port })),
  )
  assert.deepEqual(
    resolveVerifierBootstrapNodes([]),
    OFFICIAL_BOOTSTRAP_NODES.map((n) => ({ host: n.host, port: n.port })),
  )
})

test('duplicating an official node does not produce duplicates', () => {
  const official = OFFICIAL_BOOTSTRAP_NODES[0]!
  const resolved = resolveVerifierBootstrapNodes([`${official.host}:${official.port}`])
  const matches = resolved.filter((n) => n.host === official.host && n.port === official.port)
  assert.equal(matches.length, 1)
})
