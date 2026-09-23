import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, Router, SerializedHttpRequest } from '@antseed/node'
import { eligibleRouterCandidates, executeRouterSelection, resolveRouterRecommendation, resolveRouterRecommendations } from './router-execution.js'
import { createRoutingServiceMetadata } from '@antseed/node'

const peer = {
  peerId: 'a'.repeat(40) as PeerInfo['peerId'], providers: ['openai'], lastSeen: Date.now(), reputationScore: 90,
  providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'model-a': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
  providerServiceApiProtocols: { openai: { services: { 'model-a': ['openai-chat-completions'] } } },
} as PeerInfo
const request: SerializedHttpRequest = {
  requestId: 'original', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ model: 'levanto-auto', messages: [{ role: 'user', content: 'Hello' }], stream: true })),
}
const candidates = () => eligibleRouterCandidates(request, [peer], [], null, () => true)

test('recommendations resolve models or exact peers, never unsupported reasoning', () => {
  const available = candidates()
  assert.equal(available.length, 1)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'model-a' }], available)?.peerId, peer.peerId)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'model-a', peerId: 'b'.repeat(40) }], available), null)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'model-a', inference: { reasoningEffort: 'high' } }], available), null)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'missing' }, { serviceId: 'model-a' }], available)?.serviceId, 'model-a')
})

test('generic preferences are validated before invoking a router', async () => {
  let calls = 0
  const metadata = createRoutingServiceMetadata({ type: 'object', additionalProperties: false,
    properties: { policy: { type: 'string', enum: ['cost', 'quality'], default: 'cost' } } })
  const router: Router = {
    selectPeer: () => null, onResult: () => {}, routingMetadata: metadata,
    async selectRoute(_request, _peers, context) {
      calls++
      assert.deepEqual(context.preferences, { policy: 'quality' })
      assert.equal(context.preferencesSchemaHash, metadata.preferencesSchemaHash)
      return [{ serviceId: 'model-a' }]
    },
  }
  const args = { node: { sendRequest: async () => { throw new Error('unused') } }, router, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', preferences: { policy: 'invalid' } } }), /enum/)
  assert.equal(calls, 0)
  await executeRouterSelection({ ...args, selection: { kind: 'router', preferences: { policy: 'quality' } } })
  assert.equal(calls, 1)
})

test('routing purchases cannot substitute a different routing-service peer', async () => {
  let sent = false
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, { ...request, requestId: 'routing-request' }, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { sent = true; throw new Error('must not send') } }, router, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
    selection: { kind: 'router', service: { peerId: 'b'.repeat(40), provider: 'levanto', serviceId: 'levanto-route' } },
  }), /selected routing-service peer/)
  assert.equal(sent, false)
})

test('candidate construction enforces buyer restrictions, capacity, and required parameters', () => {
  assert.equal(eligibleRouterCandidates(request, [peer], [], null, () => false).length, 0)
  assert.equal(eligibleRouterCandidates(request, [{ ...peer, maxConcurrency: 1, currentLoad: 1 }], [], null, () => true).length, 0)
  assert.equal(eligibleRouterCandidates(request, [peer], ['tools'], null, () => true).length, 0)
  assert.equal(eligibleRouterCandidates(request, [peer], [], {
    preferFreePeers: false, maxInputUsdPerMillion: 0.5, minTrustScore: 0, allowedPeerIds: [], blockedPeerIds: [],
  }, () => true).length, 0)
})

test('buyer handoff preserves inference payload and sets the resolved seller/provider', async () => {
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      const routes = [{ serviceId: 'model-a' }]
      assert.equal(context.acceptRecommendations(routes), true)
      return routes
    },
  }
  const result = await executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('unexpected network request') } },
    router, request, peers: [peer], candidates: candidates(), conversationKey: 'conversation', signal: new AbortController().signal,
  })
  assert.equal(result.request.requestId, 'original')
  assert.equal(result.request.headers['x-antseed-pin-peer'], peer.peerId)
  assert.equal(result.request.headers['x-antseed-provider'], 'openai')
  assert.deepEqual(JSON.parse(Buffer.from(result.request.body).toString()), { model: 'model-a', messages: [{ role: 'user', content: 'Hello' }], stream: true })
  assert.equal(result.candidates.length, 1)
  assert.equal(JSON.parse(Buffer.from(request.body).toString()).model, 'levanto-auto')
})

test('ranked recommendations expand model-only entries in policy order and deduplicate exact destinations', () => {
  const first = candidates()[0]!
  const second = { ...first, peerId: 'b'.repeat(40) as PeerInfo['peerId'] }
  const third = { ...first, serviceId: 'model-b' }
  const available = [first, second, third]
  const resolved = resolveRouterRecommendations([
    { serviceId: 'model-a', peerId: second.peerId },
    { serviceId: 'model-b' },
    { serviceId: 'model-a' },
    { serviceId: 'model-a', peerId: second.peerId },
  ], available)
  assert.deepEqual(resolved, [second, third, first])
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: 'model-a', peerId: second.peerId }], available), [second])
})

test('a plugin cannot change fallback destinations after response acceptance', async () => {
  const available = candidates()
  available.push({ ...available[0]!, serviceId: 'model-b' })
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-a' }, { serviceId: 'model-b' }]), true)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-a' }]), false)
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('unused') } }, router, request, peers: [peer],
    candidates: available, conversationKey: null, signal: new AbortController().signal,
  }), /no eligible/)
})

test('explicit routing fails closed on decline and respects cancellation even if plugin ignores it', async () => {
  const router: Router = { selectPeer: () => null, onResult: () => {}, selectRoute: async () => null }
  const args = { node: { sendRequest: async () => { throw new Error('unused') } }, router, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await assert.rejects(executeRouterSelection(args), /no eligible/)
  const abort = new AbortController()
  router.selectRoute = () => new Promise(() => {})
  const pending = executeRouterSelection({ ...args, signal: abort.signal })
  abort.abort(new Error('client disconnected'))
  await assert.rejects(pending, /client disconnected/)
})

test('routing purchases are registered before dispatch and retain their own immutable request ID', async () => {
  const tracked: string[] = []
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      const serviceRequest = { ...request, requestId: 'routing-purchase' }
      const pending = context.sendRequest(peer, serviceRequest, {})
      serviceRequest.requestId = 'changed-after-dispatch'
      await pending
      return [{ serviceId: 'model-a' }]
    },
  }
  await executeRouterSelection({
    node: { sendRequest: async (_peer, serviceRequest) => {
      assert.deepEqual(tracked, ['routing-purchase'])
      await Promise.resolve()
      assert.equal(serviceRequest.requestId, 'routing-purchase')
      return { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }
    } }, router, request, peers: [peer], candidates: candidates(), conversationKey: 'chat',
    signal: new AbortController().signal, onRoutingRequest: requestId => tracked.push(requestId),
  })
})

test('routing purchases cannot reuse the parent inference request ID', async () => {
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, request, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('must not dispatch') } }, router, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
  }), /distinct request ID/)
})
