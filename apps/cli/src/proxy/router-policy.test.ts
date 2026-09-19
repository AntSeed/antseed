import assert from 'node:assert/strict'
import test from 'node:test'
import { createPerCallBillingModel, type PeerInfo } from '@antseed/node'
import { validateRouterCandidate } from './router-policy.js'

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
