import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVerifierCapabilities, normalizeVerifierIds, parseVerifierCapabilities, selectVerifier } from './verifier.js'

const TEE = 'refoundhq-antseed-verifier'

test('buildVerifierCapabilities: first id is the default; dot-separated (PEER_CAPABILITY_PATTERN-safe)', () => {
  assert.deepEqual(buildVerifierCapabilities([TEE, 'acme-x']), [
    'verifier.refoundhq-antseed-verifier',
    'verifier-default.refoundhq-antseed-verifier',
    'verifier.acme-x',
  ])
})

test('parseVerifierCapabilities: round-trips + ignores unrelated caps', () => {
  const caps = buildVerifierCapabilities([TEE, 'acme-x'])
  assert.deepEqual(parseVerifierCapabilities([...caps, 'verification.response-auth.v1']), {
    supported: [TEE, 'acme-x'],
    default: TEE,
  })
  assert.deepEqual(parseVerifierCapabilities(['verification.response-auth.v1']), { supported: [] })
})

test('parseVerifierCapabilities: ignores malformed verifier ids', () => {
  assert.deepEqual(
    parseVerifierCapabilities([
      'verifier.@scope/pkg',
      'verifier-default.has space',
      'verifier.good-id',
    ]),
    { supported: ['good-id'] },
  )
})

test('selectVerifier: ordered preference returns first supported, skipping unsupported', () => {
  const sup = { supported: ['acme-x', TEE], default: 'acme-x' }
  assert.equal(selectVerifier({ require: false, prefer: ['nope-x', TEE, 'acme-x'] }, sup), TEE)
})

test('selectVerifier: no preference -> seller default if curated-trusted', () => {
  const sup = { supported: [TEE], default: TEE }
  assert.equal(selectVerifier({ require: false }, sup), TEE)
})

test('selectVerifier: no preference + untrusted default -> null', () => {
  const sup = { supported: ['acme-untrusted'], default: 'acme-untrusted' }
  assert.equal(selectVerifier({ require: false }, sup), null)
})

test('selectVerifier: preference set but none supported -> null', () => {
  const sup = { supported: [TEE], default: TEE }
  assert.equal(selectVerifier({ require: false, prefer: ['nope-x'] }, sup), null)
})

test('normalizeVerifierIds: lowercases, dedupes, drops blanks', () => {
  assert.deepEqual(
    normalizeVerifierIds(' Refoundhq-Antseed-Verifier , acme-x , refoundhq-antseed-verifier , '),
    ['refoundhq-antseed-verifier', 'acme-x'],
  )
})

test('normalizeVerifierIds: rejects ids with invalid chars (@ / space)', () => {
  for (const bad of ['@scope/pkg', 'has space', 'up/slash']) {
    assert.throws(() => normalizeVerifierIds(bad), /invalid verifier id/)
  }
})
