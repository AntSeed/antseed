import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, Router, SerializedHttpRequest } from '@antseed/node'
import { eligibleRouterCandidates, executeRouterSelection, resolveRouterRecommendation } from './router-execution.js'

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
  assert.equal(result.requestId, 'original')
  assert.equal(result.headers['x-antseed-pin-peer'], peer.peerId)
  assert.equal(result.headers['x-antseed-provider'], 'openai')
  assert.deepEqual(JSON.parse(Buffer.from(result.body).toString()), { model: 'model-a', messages: [{ role: 'user', content: 'Hello' }], stream: true })
  assert.equal(JSON.parse(Buffer.from(request.body).toString()).model, 'levanto-auto')
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
