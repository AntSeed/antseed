import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CANONICAL_KBF_DOMAINS,
  CANONICAL_KBF_DOMAIN_POLICY_VERSION,
  MODEL_IDENTITY_MATH_DECIMAL_RELATIVE_TOLERANCE,
  canonicalKbfDomain,
  canonicalKbfTolerance,
  createCanonicalKbfProbe,
} from './canonical-kbf-domains.js'

test('canonical registry freezes the fifteen public KBF domains', () => {
  assert.deepEqual(CANONICAL_KBF_DOMAINS.map((domain) => domain.key), [
    'chemistry_bp',
    'chemistry_mp',
    'physics',
    'astronomy',
    'biology',
    'math',
    'programming',
    'medical',
    'pop_culture',
    'internet_culture',
    'chinese_history',
    'chinese_geography',
    'chinese_internet',
    'chinese_literature',
    'crypto_params',
  ])
  assert.deepEqual(canonicalKbfDomain('chemistry_bp').range, [-300, 600])
  assert.deepEqual(canonicalKbfDomain('physics').tolerance, { mode: 'relative', value: 0.02 })
  assert.deepEqual(canonicalKbfDomain('medical').tolerance, { mode: 'relative', value: 0.1 })
})

test('integer mathematics remains exact', () => {
  assert.deepEqual(canonicalKbfTolerance('math', 326240), { mode: 'absolute', value: 0 })
})

test('decimal mathematics uses the documented ten-significant-digit model-identity tolerance', () => {
  assert.deepEqual(canonicalKbfTolerance('math', 2.955765285651995), {
    mode: 'relative',
    value: MODEL_IDENTITY_MATH_DECIMAL_RELATIVE_TOLERANCE,
  })
})

test('probe policy is derived from the canonical domain rather than authored fields', () => {
  const probe = createCanonicalKbfProbe({
    domainKey: 'chemistry_mp',
    name: 'test compound',
    consensus: 123,
    generationRound: 2,
    generationTheme: 'test theme',
  })
  assert.deepEqual(probe.range, [-300, 4000])
  assert.deepEqual(probe.tolerance, { mode: 'absolute', value: 3 })
  assert.equal(probe.domainPolicyVersion, CANONICAL_KBF_DOMAIN_POLICY_VERSION)
  assert.equal(probe.template, 'The melting point of test compound is ___°C.')
})

test('canonical probe creation rejects out-of-domain values and unknown domains', () => {
  assert.throws(() => createCanonicalKbfProbe({
    domainKey: 'programming',
    name: 'future runtime',
    consensus: 3000,
    generationRound: 1,
    generationTheme: 'test',
  }), /outside programming range/)
  assert.throws(() => canonicalKbfDomain('unclassified'), /unknown canonical KBF domain/)
})
