import assert from 'node:assert/strict'
import test from 'node:test'
import { createPerCallBillingModel, type PeerInfo, type RouteSelectionContext } from '@antseed/node'
import type { RoutingServiceConfig } from '../config/types.js'
import { RoutingServiceExecutor } from './routing-service.js'

const settings: RoutingServiceConfig = { peerId: 'a'.repeat(40), provider: 'openai', serviceId: 'route-classifier' }

function setup(overrides: Partial<RoutingServiceConfig> = {}, price = 1) {
  const config = { ...settings, ...overrides }
  const peer: PeerInfo = {
    peerId: settings.peerId as PeerInfo['peerId'], lastSeen: Date.now(), providers: ['openai'],
    providerServiceCapabilities: { openai: { services: { 'route-classifier': { routing: true } } } },
    providerServiceApiProtocols: { openai: { services: { 'route-classifier': ['openai-chat-completions'] } } },
    providerPricing: { openai: { defaults: { inputUsdPerMillion: price, outputUsdPerMillion: price * 2 },
      services: { 'route-classifier': { inputUsdPerMillion: price, outputUsdPerMillion: price * 2 } } } },
  }
  const sent: any[] = []
  const records: Record<string, unknown>[] = []
  const policy = { maxPricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 1 } } }
  const host: ConstructorParameters<typeof RoutingServiceExecutor>[0] = {
    getPolicy: () => policy, getPeers: async () => [peer], record: (event) => { records.push(event) },
    node: { buyerPaymentManager: { maxPerRequestUsdc: 10000n } as any, sendRequest: async (...args: any[]) => {
      sent.push(args)
      const response = { requestId: args[1].requestId, statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'test-model' } }], usage: { prompt_tokens: 100, completion_tokens: 20 },
      })) }
      const validateResponse = args[2]?.acceptResponse
      if (validateResponse && validateResponse(response) !== true) throw new Error('invalid classification')
      return response
    } },
  }
  const executor = new RoutingServiceExecutor(host)
  const invoke = executor.invoke.bind(executor)
  executor.invoke = (parent, context, messages, parser, target = config) => invoke(parent, context, messages, parser, target)
  const controller = new AbortController()
  const context: RouteSelectionContext = { signal: controller.signal, deadlineMs: Date.now() + 10_000 }
  const messages = [{ role: 'user' as const, content: 'private example prompt' }]
  return { executor, context, messages, sent, records, config, peer, controller, host, policy }
}

test('selected routing services use ordinary metered execution and existing policy', async () => {
  const state = setup()
  await state.executor.invoke('parent', state.context, state.messages)
  assert.equal(state.sent.length, 1)
  const [peer, request, options] = state.sent[0]
  assert.equal(peer.peerId, settings.peerId)
  assert.notEqual(request.requestId, 'parent')
  assert.equal(request.path, '/v1/chat/completions')
  assert.equal(request.headers['x-antseed-provider'], 'openai')
  assert.deepEqual(options.attribution, { purpose: 'routing', parentRequestId: 'parent' })
  assert.equal(options.controlPlane, undefined)
  assert.equal(JSON.parse(request.body.toString()).max_tokens, undefined)
  assert.equal(state.records[0]?.outcome, 'succeeded')
  assert.doesNotMatch(JSON.stringify(state.records), /private example prompt/)
})

test('concurrent duplicate calls share one operation and a different input cannot buy another call', async () => {
  const state = setup()
  const results = await Promise.all([
    state.executor.invoke('parent', state.context, state.messages),
    state.executor.invoke('parent', state.context, state.messages),
  ])
  assert.equal(results[0], results[1])
  assert.equal(state.sent.length, 1)
  await assert.rejects(state.executor.invoke('parent', state.context, [{ role: 'user', content: 'changed' }]), /Only one/)
  await assert.rejects(state.executor.invoke('parent', state.context, state.messages, undefined, { ...state.config, peerId: 'b'.repeat(40) }), /Only one/)
})

for (const statusCode of [429, 503]) {
  test(`HTTP ${statusCode} is not automatically retried as another paid classification`, async () => {
    const state = setup()
    const send = state.host.node.sendRequest
    state.host.node.sendRequest = async (...args) => ({ ...await send(...args), statusCode })
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages), /rejected/)
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages), /rejected/)
    assert.equal(state.sent.length, 1)
  })
}

test('an ambiguous transport failure is not retried', async () => {
  const state = setup()
  let calls = 0
  state.host.node.sendRequest = async () => { calls++; throw new Error('connection lost after send') }
  await assert.rejects(state.executor.invoke('parent', state.context, state.messages), /connection lost/)
  await assert.rejects(state.executor.invoke('parent', state.context, state.messages), /connection lost/)
  assert.equal(calls, 1)
})

test('free routing never grants paid negotiation', async () => {
  const state = setup({}, 0)
  await state.executor.invoke('parent', state.context, state.messages)
  assert.deepEqual(state.sent[0][2].attribution, { purpose: 'routing', parentRequestId: 'parent' })
})

for (const invalid of ['capability', 'provider', 'service', 'input-price', 'output-price', 'cached-price']) {
  test(`rejects invalid routing ${invalid} before sending`, async () => {
    const state = setup()
    if (invalid === 'capability') delete state.peer.providerServiceCapabilities
    if (invalid === 'provider') state.config.provider = 'other'
    if (invalid === 'service') state.config.serviceId = 'other'
    if (invalid === 'input-price') state.policy.maxPricing.defaults.inputUsdPerMillion = 0
    if (invalid === 'output-price') state.policy.maxPricing.defaults.outputUsdPerMillion = 0
    if (invalid === 'cached-price') state.policy.maxPricing.defaults.cachedInputUsdPerMillion = 0
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages))
    assert.equal(state.sent.length, 0)
  })
}

for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`rejects invalid advertised price ${price}`, async () => {
    const state = setup({}, price)
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages))
    assert.equal(state.sent.length, 0)
  })
}

test('cancellation or expiry prevents dispatch', async () => {
  const state = setup()
  state.context.deadlineMs = Date.now() - 1
  await assert.rejects(state.executor.invoke('parent', state.context, state.messages), /deadline/)
  state.controller.abort()
  assert.throws(() => state.executor.invoke('other', state.context, state.messages))
  assert.equal(state.sent.length, 0)
})

test('shutdown cancels active service calls', async () => {
  const state = setup()
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  state.host.node.sendRequest = async (_peer, _request, options) => {
    entered()
    return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }
  const result = assert.rejects(state.executor.invoke('parent', state.context, state.messages), /cancelled/)
  await started
  state.executor.cancel()
  await result
  assert.equal(state.records[0]?.outcome, 'cancelled')
})

function setupPerCall() {
  const state = setup({}, 0)
  state.peer.providerServiceUnitBillingModels = { openai: { services: {
    'route-classifier': { 'openai-chat-completions': createPerCallBillingModel('5000') },
  } } }
  state.context.candidates = [{ peerId: 'b'.repeat(40), serviceId: 'test-model', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]
  return state
}

test('per-call routing validates the recommendation and authorizes only the advertised fee', async () => {
  const state = setupPerCall()
  let validations = 0
  const parseResponse = (response: { body: Uint8Array }) => {
    validations++
    const model = JSON.parse(new TextDecoder().decode(response.body)).choices[0].message.content
    return [{ peerId: 'b'.repeat(40), serviceId: model }]
  }
  await Promise.all([
    state.executor.invoke('parent', state.context, state.messages, parseResponse),
    state.executor.invoke('parent', state.context, state.messages, parseResponse),
  ])
  assert.equal(validations, 1)
  assert.equal(state.sent.length, 1)
  assert.equal(typeof state.sent[0][2].acceptResponse, 'function')
  assert.equal(state.records[0]?.outcome, 'succeeded')
})

test('per-call routing requires a parser before contacting the seller', async () => {
  const state = setupPerCall()
  await assert.rejects(state.executor.invoke('parent', state.context, state.messages), /requires a classification parser/)
  assert.equal(state.sent.length, 0)
})

test('per-call fees must fit the existing payment policy', async () => {
  const state = setupPerCall()
  Object.defineProperty(state.host.node, 'buyerPaymentManager', { value: { maxPerRequestUsdc: 4999n } })
  await assert.rejects(state.executor.invoke('parent', state.context, state.messages, () => [{ serviceId: 'test-model' }]), /payment policy/)
  assert.equal(state.sent.length, 0)
})

for (const [name, routes] of Object.entries({
  'empty recommendation': [],
  'missing recommendation': null,
  'unknown model': [{ peerId: 'b'.repeat(40), serviceId: 'unadvertised' }],
  'wrong peer': [{ peerId: 'c'.repeat(40), serviceId: 'test-model' }],
  'missing model': [{ peerId: 'b'.repeat(40) }],
  'partially invalid list': [{ peerId: 'b'.repeat(40), serviceId: 'test-model' }, { peerId: 'c'.repeat(40), serviceId: 'test-model' }],
})) {
  test(`per-call validation rejects ${name} without retrying`, async () => {
    const state = setupPerCall()
    const parseResponse = () => routes as any
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages, parseResponse), /invalid classification/)
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages, parseResponse), /invalid classification/)
    assert.equal(state.sent.length, 1)
    assert.equal(state.records[0]?.outcome, 'failed')
  })
}

test('eligibility cannot be expanded by mutating the candidate snapshot during the request', async () => {
  const state = setupPerCall()
  const pending = state.executor.invoke('parent', state.context, state.messages, () => [{ peerId: 'c'.repeat(40), serviceId: 'test-model' }])
  state.context.candidates!.push({ peerId: 'c'.repeat(40), serviceId: 'test-model', inputUsdPerMillion: 1, outputUsdPerMillion: 2 })
  await assert.rejects(pending, /invalid classification/)
})

test('per-call routing accepts a model-only answer with an eligible seller', async () => {
  const state = setupPerCall()
  await state.executor.invoke('parent', state.context, state.messages, () => [{ serviceId: 'test-model' }])
  assert.equal(state.sent.length, 1)
  assert.equal(typeof state.sent[0][2].acceptResponse, 'function')
})

for (const candidates of [[], [{ peerId: 'b'.repeat(40), serviceId: 'another-model', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]]) {
  test(`per-call routing rejects model-only answers without an eligible seller (${candidates.length} candidates)`, async () => {
    const state = setupPerCall()
    state.context.candidates = candidates
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages, () => [{ serviceId: 'test-model' }]), /invalid classification/)
  })
}

test('per-call routing accepts an exact seller followed by same-model automatic fallback', async () => {
  const state = setupPerCall()
  const exact = state.context.candidates![0]!
  await state.executor.invoke('parent', state.context, state.messages,
    () => [{ peerId: exact.peerId, serviceId: exact.serviceId }, { serviceId: exact.serviceId }])
  assert.equal(state.sent.length, 1)
})
