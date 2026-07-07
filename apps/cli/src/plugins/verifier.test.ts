import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVerifierCapabilities, getCachedVerdict, normalizeVerifierIds, parseVerifierCapabilities, resolveVerifierPolicy, selectVerifier, verifierSupportFingerprint, withVerifyTimeout, type CachedVerdict, type VerifyOutcome } from './verifier.js'

const TEE = 'refoundhq-antseed-verifier'
const OK: VerifyOutcome = { ok: true, verified: true }

function countedRun(outcome: VerifyOutcome = OK): { run: () => Promise<VerifyOutcome>; runs: () => number } {
  let count = 0
  return {
    run: async () => { count++; return outcome },
    runs: () => count,
  }
}

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

test('selectVerifier: prefers requested trusted SDKs, otherwise trusted seller default', () => {
  assert.equal(
    selectVerifier({ require: false, prefer: ['nope-x', TEE, 'acme-x'] }, { supported: ['acme-x', TEE], default: 'acme-x' }),
    TEE,
  )
  assert.equal(selectVerifier({ require: false }, { supported: [TEE], default: TEE }), TEE)
  assert.equal(selectVerifier({ require: false }, { supported: ['acme-untrusted'], default: 'acme-untrusted' }), null)
  assert.equal(selectVerifier({ require: false, prefer: ['nope-x'] }, { supported: [TEE], default: TEE }), null)
})

test('normalizeVerifierIds: lowercases/dedupes/drops-blanks and rejects invalid chars', () => {
  assert.deepEqual(
    normalizeVerifierIds(' Refoundhq-Antseed-Verifier , acme-x , refoundhq-antseed-verifier , '),
    ['refoundhq-antseed-verifier', 'acme-x'],
  )
  for (const bad of ['@scope/pkg', 'has space', 'up/slash']) {
    assert.throws(() => normalizeVerifierIds(bad), /invalid verifier id/)
  }
})

test('resolveVerifierPolicy: resolves valid flags and rejects contradictions', () => {
  assert.equal(resolveVerifierPolicy({ verifier: false }), undefined)
  assert.deepEqual(resolveVerifierPolicy({ verifiers: `${TEE},acme-x`, requireVerifier: true }), {
    prefer: [TEE, 'acme-x'],
    require: true,
  })
  assert.deepEqual(resolveVerifierPolicy({}), { prefer: [], require: false })
  assert.throws(() => resolveVerifierPolicy({ verifier: false, requireVerifier: true }), /cannot be combined/)
  assert.throws(() => resolveVerifierPolicy({ verifier: false, verifiers: TEE }), /cannot be combined/)
})

test('withVerifyTimeout: resolves in time, times out, and surfaces an outer abort', async () => {
  assert.equal(await withVerifyTimeout(async () => 'ok', undefined, 1000), 'ok')
  await assert.rejects(withVerifyTimeout(() => new Promise(() => {}), undefined, 10), /timed out/)
  const ac = new AbortController()
  ac.abort(new Error('client disconnected'))
  await assert.rejects(withVerifyTimeout(() => new Promise(() => {}), ac.signal, 1000), /client disconnected/)
})

test('verifierSupportFingerprint: changes when advertised verifiers change (cache invalidation)', () => {
  const a = verifierSupportFingerprint(['verifier.refoundhq-antseed-verifier', 'verifier-default.refoundhq-antseed-verifier'])
  const b = verifierSupportFingerprint(['verifier.acme-x'])
  assert.notEqual(a, b)
  assert.equal(a, verifierSupportFingerprint(['verifier-default.refoundhq-antseed-verifier', 'verifier.refoundhq-antseed-verifier']))
})

test('getCachedVerdict: caches unexpired verdicts, re-runs otherwise, skips transient, and hard-bounds size', async () => {
  const cache = new Map<string, CachedVerdict>()
  const { run, runs } = countedRun()
  const first = await getCachedVerdict(cache, 'k', 0, 1000, 10, run)
  const second = await getCachedVerdict(cache, 'k', 1, 1000, 10, run)
  assert.equal(runs(), 1)
  assert.deepEqual(second, first)

  const changedKey = countedRun()
  const changedKeyCache = new Map<string, CachedVerdict>()
  await getCachedVerdict(changedKeyCache, 'peer|A', 0, 1000, 10, changedKey.run)
  await getCachedVerdict(changedKeyCache, 'peer|B', 0, 1000, 10, changedKey.run)
  assert.equal(changedKey.runs(), 2)

  const expired = countedRun()
  const expiredCache = new Map<string, CachedVerdict>()
  await getCachedVerdict(expiredCache, 'k', 0, 100, 10, expired.run)
  await getCachedVerdict(expiredCache, 'k', 200, 100, 10, expired.run)
  assert.equal(expired.runs(), 2)

  const transient = countedRun({ ok: false, verified: false, transient: true })
  const transientCache = new Map<string, CachedVerdict>()
  await getCachedVerdict(transientCache, 'k', 0, 1000, 10, transient.run)
  await getCachedVerdict(transientCache, 'k', 0, 1000, 10, transient.run)
  assert.equal(transient.runs(), 2)
  assert.equal(transientCache.size, 0)

  const bounded = new Map<string, CachedVerdict>()
  for (let i = 0; i < 15; i++) await getCachedVerdict(bounded, `k${i}`, 0, 1_000_000, 10, async () => OK)
  assert.ok(bounded.size <= 10, `cache size ${bounded.size} exceeded max 10`)
})
