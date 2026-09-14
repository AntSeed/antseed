import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import type { RoutingServiceConfig } from '../config/types.js'
import { RoutingServiceExecutor } from './routing-service.js'

const settings: RoutingServiceConfig = {
  routerKey: 'instance:classifier', peerId: 'a'.repeat(40), provider: 'openai', serviceId: 'route-classifier',
  allowPromptSharing: true, maxInputUsdPerMillion: 1, maxOutputUsdPerMillion: 2, maxCachedInputUsdPerMillion: 1,
  maxAdditionalAuthorizationUsdc: '1000', maxRequestsPerMinute: 5, maxInputBytes: 1000, maxOutputTokens: 32,
}

function setup(overrides: Partial<RoutingServiceConfig> = {}, price = 1) {
  const config = { ...settings, ...overrides }
  const peer: PeerInfo = {
    peerId: settings.peerId as PeerInfo['peerId'], lastSeen: Date.now(), providers: ['openai'],
    providerServiceApiProtocols: { openai: { services: { 'route-classifier': ['openai-chat-completions'] } } },
    providerPricing: { openai: { defaults: { inputUsdPerMillion: price, outputUsdPerMillion: price * 2 },
      services: { 'route-classifier': { inputUsdPerMillion: price, outputUsdPerMillion: price * 2 } } } },
  }
  const sent: any[] = []
  const records: Record<string, unknown>[] = []
  const executor = new RoutingServiceExecutor({ routerKey: settings.routerKey,
    getConfig: () => config, getPeers: async () => [peer], record: async (event) => { records.push(event) },
    node: { sendRequest: async (...args: any[]) => {
      sent.push(args)
      return { requestId: args[1].requestId, statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'test-model' } }], usage: { prompt_tokens: 100, completion_tokens: 20 },
      })) }
    } },
  })
  const controller = new AbortController()
  const context = { signal: controller.signal, deadlineMs: Date.now() + 10_000 }
  const messages = [{ role: 'user' as const, content: 'private example prompt' }]
  return { executor, context, messages, sent, records, config, peer, controller }
}

test('routing service uses ordinary metered SDK execution with a separate ID', async () => {
  const state = setup()
  await state.executor.invoke('inference-id', state.context, state.messages)
  const [, request, options] = state.sent[0]
  assert.notEqual(request.requestId, 'inference-id')
  assert.equal(request.path, '/v1/chat/completions')
  assert.equal(options.controlPlane, undefined)
  assert.deepEqual(options.routingAuthorization, { parentRequestId: 'inference-id', maxAdditionalAuthorizationUsdc: '1000' })
  assert.deepEqual(JSON.parse(request.body), { model: 'route-classifier', messages: state.messages, stream: false, max_tokens: 32 })
  assert.equal(state.records[0]?.parentRequestId, 'inference-id')
  assert.doesNotMatch(JSON.stringify(state.records), /private example prompt/)
})

test('duplicate concurrent calls reuse one routing operation', async () => {
  const state = setup()
  const results = await Promise.all([
    state.executor.invoke('parent', state.context, state.messages),
    state.executor.invoke('parent', state.context, state.messages),
  ])
  assert.equal(state.sent.length, 1)
  assert.equal(results[0], results[1])
  await assert.rejects(state.executor.invoke('parent', state.context, [{ role: 'user', content: 'different' }]), /Only one/)
})

for (const [name, overrides] of Object.entries({
  'wrong instance': { routerKey: 'instance:other' },
  'no prompt consent': { allowPromptSharing: false },
  'no spending consent': { maxAdditionalAuthorizationUsdc: '0' },
  'input rate': { maxInputUsdPerMillion: 0 },
  'output rate': { maxOutputUsdPerMillion: 0 },
  'cached rate': { maxCachedInputUsdPerMillion: 0 },
  'input size': { maxInputBytes: 1 },
  'wrong seller': { peerId: 'b'.repeat(40) },
  'wrong service': { serviceId: 'missing' },
})) {
  test(`routing service blocks ${name} before dispatch`, async () => {
    const state = setup(overrides)
    await assert.rejects(state.executor.invoke('parent', state.context, state.messages))
    assert.equal(state.sent.length, 0)
  })
}

test('free routing does not grant paid negotiation', async () => {
  const state = setup({ maxAdditionalAuthorizationUsdc: '0' }, 0)
  await state.executor.invoke('parent', state.context, state.messages)
  assert.equal(state.sent[0][2].routingAuthorization.maxAdditionalAuthorizationUsdc, '0')
})

test('routing rate limit counts distinct operations, not cache hits', async () => {
  const state = setup({ maxRequestsPerMinute: 1 })
  await state.executor.invoke('first', state.context, state.messages)
  await state.executor.invoke('first', state.context, state.messages)
  await assert.rejects(state.executor.invoke('second', state.context, state.messages), /rate limit/)
  assert.equal(state.sent.length, 1)
})

test('cancellation stops an invocation before seller dispatch', async () => {
  const state = setup()
  const pending = state.executor.invoke('parent', state.context, state.messages)
  state.executor.cancel()
  await assert.rejects(pending)
  assert.equal(state.sent.length, 0)
})
