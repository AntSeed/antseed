import assert from 'node:assert/strict'
import test from 'node:test'
import { areRouteRecommendationsEligible, createPerCallBillingModel, type PeerInfo, type ServiceCapabilities } from '@antseed/node'
import { validateRouterCandidate, resolveRouterRecommendation } from './router-policy.js'

function fixture() {
  const peer: PeerInfo = {
    peerId: 'a'.repeat(40) as PeerInfo['peerId'], providers: ['openai'], lastSeen: Date.now(),
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } } },
    providerServiceApiProtocols: { openai: { services: { model: ['openai-chat-completions', 'openai-responses'] } } },
  }
  const options: Parameters<typeof validateRouterCandidate>[0] = {
    recommendation: { peerId: peer.peerId, serviceId: 'model' }, peers: [peer],
    request: { requestId: 'request', method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ messages: [] })) },
    protocol: 'openai-chat-completions', provider: null, requiredParameters: [], preferences: null,
    maxPricing: { defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 } }, now: Date.now(),
  }
  return { peer, options }
}

test('model-only efforts allow unknown capabilities and preserve the router override', () => {
  const { peer, options } = fixture()
  options.maxPricing = undefined
  const other = { ...peer, peerId: 'b'.repeat(40) as PeerInfo['peerId'] }
  peer.providerServiceCapabilities = { openai: { services: { model: { reasoning: true, reasoningEfforts: ['low', 'high'] } } } }
  const candidates = resolveRouterRecommendation({ ...options, peers: [other, peer], recommendation: { serviceId: 'model', inference: { reasoningEffort: 'high' } } })
  assert.equal(candidates.length, 2)
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.peerId)), new Set([peer.peerId, other.peerId]))
  for (const candidate of candidates) {
    assert.equal(candidate.reasoningOverride, 'high')
    assert.deepEqual(candidate.inference, { reasoningEffort: 'high' })
  }
  assert.ok(validateRouterCandidate({ ...options, peers: [other], recommendation: { serviceId: 'model', peerId: other.peerId, inference: { reasoningEffort: 'high' } } }))
  peer.providerServiceCapabilities.openai!.services.model = { reasoning: false }
  assert.equal(validateRouterCandidate(options)!.reasoningOverride, null)
  peer.providerServiceCapabilities.openai!.services.model = {}
  assert.equal(validateRouterCandidate(options)!.reasoningOverride, undefined)
})

const capabilityCases: Array<{ capabilities?: ServiceCapabilities; allowed: boolean }> = [
  { allowed: true },
  { capabilities: {}, allowed: true },
  { capabilities: { reasoning: true }, allowed: true },
  { capabilities: { reasoningEfforts: ['low', 'high'] }, allowed: true },
  { capabilities: { reasoningEfforts: ['low'] }, allowed: false },
  { capabilities: { reasoning: false }, allowed: false },
]

for (const { capabilities, allowed } of capabilityCases) {
  test(`reasoning overrides respect explicit capabilities ${JSON.stringify(capabilities)}`, () => {
    const { peer, options } = fixture()
    options.maxPricing = undefined
    if (capabilities !== undefined) {
      peer.providerServiceCapabilities = { openai: { services: { model: structuredClone(capabilities) } } }
    }
    options.recommendation.inference = { reasoningEffort: 'high' }
    const candidate = validateRouterCandidate(options)
    if (!allowed) assert.equal(candidate, null)
    else {
      assert.ok(candidate)
      assert.equal(candidate.reasoningOverride, 'high')
      assert.ok(candidate.reasoningEfforts.includes('high'))
    }
  })
}

for (const [protocol, unsupported] of [['openai-chat-completions', 'max'], ['openai-responses', 'max'], ['anthropic-messages', 'minimal']] as const) {
  test(`missing capabilities do not allow unsupported ${unsupported} over ${protocol}`, () => {
    const { peer, options } = fixture()
    options.maxPricing = undefined
    options.protocol = protocol
    peer.providerServiceApiProtocols!.openai!.services.model = [protocol]
    const candidate = validateRouterCandidate(options)
    assert.ok(candidate)
    assert.ok(!candidate.reasoningEfforts.includes(unsupported))
    options.recommendation.inference = { reasoningEffort: unsupported }
    assert.equal(validateRouterCandidate(options), null)
    assert.equal(areRouteRecommendationsEligible([options.recommendation], [candidate]), false)
    options.recommendation.inference = { reasoningEffort: 'unknown' as never }
    assert.equal(validateRouterCandidate(options), null)
  })
}

test('non-reasoning sellers allow disabling reasoning but not enabling it', () => {
  const { peer, options } = fixture()
  options.maxPricing = undefined
  peer.providerServiceCapabilities = { openai: { services: { model: { reasoning: false } } } }
  options.recommendation.inference = { reasoningEffort: 'none' }
  assert.equal(validateRouterCandidate(options)!.reasoningOverride, null)
  options.recommendation.inference = { reasoningEffort: 'high' }
  assert.equal(validateRouterCandidate(options), null)
})

test('router recommendations respect the existing global buyer limits', () => {
  const { options } = fixture()
  assert.equal(validateRouterCandidate(options), null)
  options.maxPricing!.defaults = { inputUsdPerMillion: 20, outputUsdPerMillion: 20 }
  assert.ok(validateRouterCandidate(options))
  options.maxPricing!.defaults.cachedInputUsdPerMillion = 1
  assert.equal(validateRouterCandidate(options), null)
})


test('routing-capable services are excluded from inference regardless of their name', () => {
  const { peer, options } = fixture()
  options.maxPricing = undefined
  peer.providerServiceCapabilities = { openai: { services: { model: { routing: true } } } }
  assert.equal(validateRouterCandidate(options), null)
  peer.providerServiceCapabilities.openai!.services.model!.routing = false
  assert.ok(validateRouterCandidate(options))
})

for (const protocols of [['openai-responses', 'openai-chat-completions'], ['openai-chat-completions', 'openai-responses']] as const) {
  test(`per-call inference exclusion follows dispatch protocol, not order ${protocols.join(',')}`, () => {
    const { peer, options } = fixture()
    peer.providerPricing!.openai!.defaults = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    peer.providerServiceApiProtocols!.openai!.services.model = [...protocols]
    peer.providerServiceUnitBillingModels = { openai: { services: { model: {
      'openai-chat-completions': createPerCallBillingModel('5000'),
    } } } }
    assert.equal(validateRouterCandidate(options), null)
    options.protocol = 'openai-responses'
    assert.ok(validateRouterCandidate(options))
  })
}

test('explicit router requests can omit a model and receive the selected model', () => {
  const { options } = fixture()
  options.maxPricing = undefined
  const candidate = validateRouterCandidate(options)
  assert.ok(candidate)
  assert.equal(JSON.parse(Buffer.from(candidate.request.body).toString()).model, 'model')
})
