import assert from 'node:assert/strict'
import test from 'node:test'
import { areRouteRecommendationsEligible, createUnitBillingModel, type PeerInfo, type ServiceCapabilities } from '@antseed/node'
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

test('model-only efforts require advertised capabilities and preserve the router override', () => {
  const { peer, options } = fixture()
  options.maxPricing = undefined
  const other = { ...peer, peerId: 'b'.repeat(40) as PeerInfo['peerId'] }
  peer.providerServiceCapabilities = { openai: { services: { model: { reasoning: true, reasoningEfforts: ['low', 'high'] } } } }
  const candidates = resolveRouterRecommendation({ ...options, peers: [other, peer], recommendation: { serviceId: 'model', inference: { reasoningEffort: 'high' } } })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.peerId, peer.peerId)
  for (const candidate of candidates) {
    assert.equal(candidate.reasoningOverride, 'high')
    assert.deepEqual(candidate.inference, { reasoningEffort: 'high' })
  }
  assert.equal(validateRouterCandidate({ ...options, peers: [other], recommendation: { serviceId: 'model', peerId: other.peerId, inference: { reasoningEffort: 'high' } } }), null)
  peer.providerServiceCapabilities.openai!.services.model = { reasoning: false }
  assert.equal(validateRouterCandidate(options)!.reasoningOverride, null)
  peer.providerServiceCapabilities.openai!.services.model = {}
  assert.equal(validateRouterCandidate(options)!.reasoningOverride, undefined)
})

const capabilityCases: Array<{ capabilities?: ServiceCapabilities; allowed: boolean }> = [
  { allowed: false },
  { capabilities: {}, allowed: false },
  { capabilities: { reasoning: true }, allowed: false },
  { capabilities: { reasoningEfforts: [] }, allowed: false },
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
  test(`missing capabilities do not invent ${unsupported} support over ${protocol}`, () => {
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

for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages'] as const) {
  test(`routing accepts seller-defined choices over ${protocol} without a fixed enum`, () => {
    const { peer, options } = fixture()
    options.maxPricing = undefined
    options.protocol = protocol
    peer.providerServiceApiProtocols!.openai!.services.model = [protocol]
    peer.providerServiceCapabilities = { openai: { services: { model: { reasoningEfforts: ['adaptive', 'deep-analysis'] } } } }
    options.recommendation.inference = { reasoningEffort: 'deep-analysis' }
    const candidate = validateRouterCandidate(options)
    assert.ok(candidate)
    assert.deepEqual(candidate.reasoningEfforts, ['adaptive', 'deep-analysis'])
    assert.equal(candidate.reasoningOverride, 'deep-analysis')
    options.recommendation.inference = { reasoningEffort: 'high' }
    assert.equal(validateRouterCandidate(options), null)
  })
}

test('non-reasoning sellers strip client controls but do not accept unadvertised overrides', () => {
  const { peer, options } = fixture()
  options.maxPricing = undefined
  peer.providerServiceCapabilities = { openai: { services: { model: { reasoning: false } } } }
  assert.equal(validateRouterCandidate(options)!.reasoningOverride, null)
  options.recommendation.inference = { reasoningEffort: 'none' }
  assert.equal(validateRouterCandidate(options), null)
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
      'openai-chat-completions': createUnitBillingModel('5000'),
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

test('image candidates resolve conditional prices without treating unknown prices as free', () => {
  const { peer, options } = fixture()
  options.maxPricing = undefined
  options.protocol = 'openai-images'
  options.request.path = '/v1/images/generations'
  options.request.body = Buffer.from(JSON.stringify({ model: 'model', prompt: 'cube', quality: 'hd' }))
  peer.providerServiceApiProtocols!.openai!.services.model = ['openai-images']
  peer.providerServiceUnitBillingModels = { openai: { services: { model: { 'openai-images': { version: 2, components: [
    { priceMicroUsdc: '40000' }, { priceMicroUsdc: '20000', match: { quality: 'hd' } },
  ] } } } } }
  const candidate = validateRouterCandidate(options)
  assert.ok(candidate)
  assert.equal(candidate.quantityPriceMicroUsdc, '60000')
  assert.equal(candidate.billing?.pricing, 'conditional')
  assert.equal(candidate.minImageUsdPerImage, null)
  options.maxPricing = { defaults: { inputUsdPerMillion: 25, outputUsdPerMillion: 25 } }
  assert.equal(validateRouterCandidate(options), null)
  options.maxPricing = undefined
  peer.providerServiceUnitBillingModels.openai!.services.model!['openai-images']!.components.shift()
  options.request.body = Buffer.from(JSON.stringify({ model: 'model', quality: 'standard' }))
  assert.equal(validateRouterCandidate(options), null)
})
