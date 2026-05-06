import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import { BuyerProxy, parsePersistedPeers, selectCandidatePeersForRouting, rewriteServiceInBody } from './buyer-proxy.js'

function makePeer(seed: string, providers: string[]): PeerInfo {
  const repeated = (seed.repeat(40) + 'a'.repeat(40)).slice(0, 40)
  return {
    peerId: repeated as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers,
  }
}

function makeProxyRequest(options: {
  path?: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
}): Readable {
  const body = JSON.stringify(options.body ?? { model: 'gpt-4o', messages: [] })
  const req = Readable.from([Buffer.from(body)]) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
    complete: boolean
  }
  req.method = 'POST'
  req.url = options.path ?? '/v1/chat/completions'
  req.headers = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  }
  req.complete = true
  return req
}

function makeProxyResponse(): {
  statusCode: number
  headers: Record<string, string>
  body: string
  headersSent: boolean
  writableEnded: boolean
  writeHead: (statusCode: number, headers: Record<string, string>) => unknown
  end: (chunk?: string | Buffer | Uint8Array) => unknown
  once: () => unknown
} {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(chunk?: string | Buffer | Uint8Array) {
      if (chunk !== undefined) {
        this.body += Buffer.from(chunk).toString('utf8')
      }
      this.writableEnded = true
      return this
    },
    once() {
      return this
    },
  }
}

function makeBuyerProxyWithPeers(initialPeers: PeerInfo[], refreshedPeers = initialPeers): BuyerProxy {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: {
      router: null,
    } as any,
  })
  ;(proxy as any)._getPeers = async (options?: { forceRefresh?: boolean }) =>
    options?.forceRefresh ? refreshedPeers : initialPeers
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  return proxy
}

async function invokeProxy(proxy: BuyerProxy, req: Readable): Promise<ReturnType<typeof makeProxyResponse>> {
  const res = makeProxyResponse()
  await (proxy as any)._handleRequest(req, res)
  return res
}

test('selectCandidatePeersForRouting enforces explicit provider overrides even without request protocol', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['openai']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, 'openai')
  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, peers[1]?.peerId)
  assert.equal(result.routePlanByPeerId.get(peers[1]!.peerId)?.provider, 'openai')
  assert.equal(result.routePlanByPeerId.get(peers[1]!.peerId)?.selection, null)
})

test('selectCandidatePeersForRouting returns no candidates when explicit provider is unavailable', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['local-llm']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, 'openai')
  assert.equal(result.candidatePeers.length, 0)
  assert.equal(result.routePlanByPeerId.size, 0)
})

test('selectCandidatePeersForRouting keeps all peers when no protocol or provider override is set', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['openai']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, null)
  assert.deepEqual(result.candidatePeers.map((peer) => peer.peerId), peers.map((peer) => peer.peerId))
  assert.equal(result.routePlanByPeerId.size, 0)
})

test('status control endpoint reports cached discovery state without refreshing', async () => {
  const peer = makePeer('a', ['anthropic'])
  const proxy = makeBuyerProxyWithPeers([peer])
  let refreshCalled = false
  ;(proxy as any)._refreshPeersNow = async () => {
    refreshCalled = true
    return [peer]
  }
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._lastDiscoveryPeerCount = 1

  const req = makeProxyRequest({ path: '/_antseed/status' })
  ;(req as typeof req & { method: string }).method = 'GET'
  const res = await invokeProxy(proxy, req)
  const body = JSON.parse(res.body) as { peerCache: { count: number }; discovery: { lastPeerCount: number } }

  assert.equal(refreshCalled, false)
  assert.equal(res.statusCode, 200)
  assert.equal(body.peerCache.count, 1)
  assert.equal(body.discovery.lastPeerCount, 1)
})

test('peer refresh control endpoint triggers immediate refresh', async () => {
  const refreshedPeer = makePeer('a', ['anthropic'])
  const proxy = makeBuyerProxyWithPeers([], [refreshedPeer])
  let refreshCalled = false
  ;(proxy as any)._refreshPeersNow = async () => {
    refreshCalled = true
    return [refreshedPeer]
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/peers/refresh' }))
  const body = JSON.parse(res.body) as { ok: boolean; total: number }

  assert.equal(refreshCalled, true)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(body, { ok: true, total: 1 })
})

test('selectCandidatePeersForRouting excludes peers when requested service is not in provider metadata', () => {
  const openAiPeer = makePeer('a', ['openai'])
  openAiPeer.providerServiceApiProtocols = {
    openai: {
      services: {
        'gpt-4o': ['openai-chat-completions'],
      },
    },
  }
  const claudePeer = makePeer('b', ['claude-oauth'])
  claudePeer.providerServiceApiProtocols = {
    'claude-oauth': {
      services: {
        'claude-opus-4-6': ['anthropic-messages'],
      },
    },
  }

  const result = selectCandidatePeersForRouting(
    [openAiPeer, claudePeer],
    'anthropic-messages',
    'claude-opus-4-6',
    null,
  )

  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, claudePeer.peerId)
  assert.equal(result.routePlanByPeerId.has(openAiPeer.peerId), false)
  assert.equal(result.routePlanByPeerId.get(claudePeer.peerId)?.provider, 'claude-oauth')
})

test('selectCandidatePeersForRouting in lenient mode keeps a peer whose advertised services miss the requested model, as long as the provider protocol set matches', () => {
  // The buyer explicitly pinned this peer. It advertises one service
  // (kimi-k2.6 over openai-chat-completions) but the request asks for
  // anthropic-messages with model="claude-4". Strict mode would drop the
  // peer; lenient mode keeps it and relies on the cross-protocol adapter
  // plus the seller's upstream error to surface "model not found".
  const peer = makePeer('a', ['openai'])
  peer.providerServiceApiProtocols = {
    openai: {
      services: {
        'kimi-k2.6': ['openai-chat-completions'],
      },
    },
  }

  const strict = selectCandidatePeersForRouting([peer], 'anthropic-messages', 'claude-4', null, 'strict')
  assert.equal(strict.candidatePeers.length, 0, 'strict mode should drop the peer on service mismatch')

  const lenient = selectCandidatePeersForRouting([peer], 'anthropic-messages', 'claude-4', null, 'lenient')
  assert.equal(lenient.candidatePeers.length, 1, 'lenient mode should keep the peer on service mismatch')
  const plan = lenient.routePlanByPeerId.get(peer.peerId)
  assert.ok(plan, 'expected a route plan for the lenient-kept peer')
  assert.equal(plan!.provider, 'openai')
  // Anthropic→openai transform should be the selected path.
  assert.equal(plan!.selection?.requiresTransform, true)
})

test('selectCandidatePeersForRouting in lenient mode prefers exact service matches before provider fallback', () => {
  const peer = makePeer('a', ['openai', 'local-llm'])
  peer.providerServiceApiProtocols = {
    openai: {
      services: {
        'gpt-4o': ['openai-chat-completions'],
      },
    },
    'local-llm': {
      services: {
        llama: ['openai-chat-completions'],
      },
    },
  }

  const result = selectCandidatePeersForRouting(
    [peer],
    'openai-chat-completions',
    'llama',
    null,
    'lenient',
  )

  assert.equal(result.candidatePeers.length, 1)
  const plan = result.routePlanByPeerId.get(peer.peerId)
  assert.ok(plan, 'expected a route plan for the lenient-kept peer')
  assert.equal(plan!.provider, 'local-llm')
  assert.equal(plan!.selection?.requiresTransform, false)
})

test('selectCandidatePeersForRouting can still include peers without service protocol metadata', () => {
  const peerWithoutMetadata = makePeer('a', ['openai'])
  const result = selectCandidatePeersForRouting(
    [peerWithoutMetadata],
    'openai-chat-completions',
    'gpt-4o',
    null,
  )

  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, peerWithoutMetadata.peerId)
})

test('pinned proxy request reports when no sellers are discovered', async () => {
  const proxy = makeBuyerProxyWithPeers([])
  ;(proxy as any)._lastDiscoveryError = null
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': 'a'.repeat(40),
    },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /no_sellers_available/)
  assert.match(res.body, /No AntSeed providers were discovered/)
})

test('pinned proxy request reports when the pinned peer is not discoverable', async () => {
  const pinnedPeerId = 'a'.repeat(40)
  const otherPeer = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([otherPeer])
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': pinnedPeerId,
    },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /pinned_peer_not_discoverable/)
  assert.match(res.body, /is not reachable right now/)
  assert.match(res.body, /network\/NAT\/firewall/)
})

test('pinned proxy request reports explicit provider mismatch separately', async () => {
  const pinnedPeer = makePeer('a', ['local-llm'])
  const proxy = makeBuyerProxyWithPeers([pinnedPeer])
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': pinnedPeer.peerId,
      'x-antseed-provider': 'openai',
    },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /pinned_peer_provider_mismatch/)
  assert.match(res.body, /does not offer provider=openai/)
  assert.match(res.body, /Available providers: local-llm/)
})

test('pinned proxy request reports protocol or service mismatch when provider is available', async () => {
  const pinnedPeer = makePeer('a', ['local-llm'])
  pinnedPeer.providerServiceApiProtocols = {
    'local-llm': {
      services: {
        llama: ['anthropic-messages'],
      },
    },
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer])
  const req = makeProxyRequest({
    path: '/v1/responses',
    headers: {
      'x-antseed-pin-peer': pinnedPeer.peerId,
      'x-antseed-provider': 'local-llm',
    },
    body: { model: 'llama', input: 'hello' },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /pinned_peer_service_mismatch/)
  assert.match(res.body, /does not support this request/)
  assert.match(res.body, /provider=local-llm/)
  assert.match(res.body, /protocol=openai-responses/)
})

// parsePersistedPeers — hydrates _cachedPeers from buyer.state.json at startup
// so the first request after launch can route from the warm cache without
// blocking on DHT discovery.

const validPeerId = 'a'.repeat(40)
const MAX_AGE_MS = 2 * 60 * 60_000
const NOW = 1_700_000_000_000

test('parsePersistedPeers returns [] for null/undefined/junk input', () => {
  assert.deepEqual(parsePersistedPeers(null, NOW), [])
  assert.deepEqual(parsePersistedPeers(undefined, NOW), [])
  assert.deepEqual(parsePersistedPeers(42, NOW), [])
  assert.deepEqual(parsePersistedPeers('nope', NOW), [])
})

test('parsePersistedPeers returns [] when discoveredPeers is missing or not an array', () => {
  assert.deepEqual(parsePersistedPeers({}, NOW), [])
  assert.deepEqual(parsePersistedPeers({ discoveredPeers: 'oops' }, NOW), [])
  assert.deepEqual(parsePersistedPeers({ discoveredPeers: null }, NOW), [])
})

test('parsePersistedPeers drops entries with invalid peerIds and normalizes case', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        { peerId: 'too-short', providers: [], lastSeen: NOW },
        { peerId: 123, providers: [], lastSeen: NOW },
        { peerId: validPeerId.toUpperCase(), providers: ['openai'], lastSeen: NOW },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.peerId, validPeerId)
})

test('parsePersistedPeers drops entries with non-array providers', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        { peerId: validPeerId, providers: 'openai', lastSeen: NOW },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 0)
})

test('parsePersistedPeers drops entries with stale or missing freshness anchors', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        { peerId: validPeerId, providers: ['openai'], lastSeen: NOW - MAX_AGE_MS },
        { peerId: 'b'.repeat(40), providers: ['openai'] },
        { peerId: 'c'.repeat(40), providers: ['openai'], lastSeen: 'nope' },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 0)
})

test('parsePersistedPeers keeps peer with stale lastSeen but recent lastReachedAt', () => {
  // A peer whose DHT announcement record aged out but the buyer recently
  // transported a request through is known-alive locally — survive.
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - MAX_AGE_MS - 60_000,
          lastReachedAt: NOW - 60_000,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.lastReachedAt, NOW - 60_000)
})

test('parsePersistedPeers keeps peer with missing lastSeen but valid lastReachedAt', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          // lastSeen omitted entirely — freshness anchor comes solely from lastReachedAt.
          lastReachedAt: NOW - 10_000,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.lastReachedAt, NOW - 10_000)
})

test('parsePersistedPeers drops peer when both lastSeen and lastReachedAt are stale', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - MAX_AGE_MS - 1,
          lastReachedAt: NOW - MAX_AGE_MS - 1,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 0)
})

test('parsePersistedPeers preserves provider metadata so routing filters still work', () => {
  const persisted = {
    discoveredPeers: [
      {
        peerId: validPeerId,
        displayName: 'Alice',
        publicAddress: '1.2.3.4:1234',
        providers: ['claude-oauth'],
        services: ['claude-opus-4-6'],
        providerPricing: null,
        providerServiceCategories: null,
        providerServiceApiProtocols: {
          'claude-oauth': {
            services: {
              'claude-opus-4-6': ['anthropic-messages'],
            },
          },
        },
        defaultInputUsdPerMillion: 3,
        defaultOutputUsdPerMillion: 15,
        maxConcurrency: 4,
        lastSeen: NOW - 5_000,
      },
    ],
  }
  const [peer] = parsePersistedPeers(persisted, NOW)
  assert.ok(peer, 'expected a peer')
  assert.equal(peer!.peerId, validPeerId)
  assert.equal(peer!.displayName, 'Alice')
  assert.equal(peer!.publicAddress, '1.2.3.4:1234')
  assert.deepEqual(peer!.providers, ['claude-oauth'])
  assert.equal(peer!.defaultInputUsdPerMillion, 3)
  assert.equal(peer!.defaultOutputUsdPerMillion, 15)
  assert.equal(peer!.maxConcurrency, 4)
  assert.equal(peer!.lastSeen, NOW - 5_000)

  // The hydrated peer should still satisfy the routing filter for its service.
  const result = selectCandidatePeersForRouting(
    [peer!],
    'anthropic-messages',
    'claude-opus-4-6',
    null,
  )
  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, validPeerId)
  assert.equal(result.routePlanByPeerId.get(validPeerId)?.provider, 'claude-oauth')
})

test('parsePersistedPeers restores sellerContract into peer.metadata', () => {
  // Regression: dropping sellerContract through the persistence layer caused
  // SellerAddressResolver to fall back to peerIdToAddress, so the buyer signed
  // channelId derived from the peer wallet instead of the facade address.
  // On-chain reserve() then reverted with InvalidSignature() because the
  // contract derives channelId from msg.sender (the facade).
  const facade = '1f228613116e2d08014dfdcc198377c8dedf18c9'
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 1_000,
          sellerContract: facade,
        },
      ],
    },
    NOW,
  )
  assert.ok(peer)
  assert.equal(peer!.metadata?.sellerContract, facade)
})

test('parsePersistedPeers leaves metadata undefined when sellerContract is absent', () => {
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 1_000,
        },
      ],
    },
    NOW,
  )
  assert.ok(peer)
  assert.equal(peer!.metadata, undefined)
})

test('parsePersistedPeers filters non-string entries out of providers', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai', 42, null, 'claude-oauth'],
          lastSeen: NOW,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0]?.providers, ['openai', 'claude-oauth'])
})

// rewriteServiceInBody tests

function makeJsonBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

function parseJsonBody(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
}

const jsonHeaders: Record<string, string> = { 'content-type': 'application/json' }

test('rewriteServiceInBody replaces existing model field and sets service', () => {
  const body = makeJsonBody({ model: 'claude-sonnet-4-5', messages: [] })
  const result = rewriteServiceInBody(body, jsonHeaders, 'claude-opus-4-6')
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'claude-opus-4-6')
  assert.equal(parsed['model'], 'claude-opus-4-6')
})

test('rewriteServiceInBody adds service and model fields when absent', () => {
  const body = makeJsonBody({ messages: [] })
  const result = rewriteServiceInBody(body, jsonHeaders, 'claude-opus-4-6')
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'claude-opus-4-6')
  assert.equal(parsed['model'], 'claude-opus-4-6')
})

test('rewriteServiceInBody preserves all other fields', () => {
  const body = makeJsonBody({ model: 'old', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 })
  const result = rewriteServiceInBody(body, jsonHeaders, 'new-model')
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'new-model')
  assert.equal(parsed['model'], 'new-model')
  assert.deepEqual(parsed['messages'], [{ role: 'user', content: 'hi' }])
  assert.equal(parsed['max_tokens'], 1024)
})

test('rewriteServiceInBody updates content-length header when present', () => {
  const original = makeJsonBody({ model: 'a', messages: [] })
  const headers = { 'content-type': 'application/json', 'content-length': String(original.length) }
  const result = rewriteServiceInBody(original, headers, 'claude-opus-4-6-20251201')
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('rewriteServiceInBody returns original when body is not JSON content-type', () => {
  const body = makeJsonBody({ model: 'old' })
  const headers = { 'content-type': 'text/plain' }
  const result = rewriteServiceInBody(body, headers, 'new-model')
  assert.equal(result.body, body)
  assert.equal(result.headers, headers)
})

test('rewriteServiceInBody returns original when body is empty', () => {
  const body = new Uint8Array(0)
  const result = rewriteServiceInBody(body, jsonHeaders, 'new-model')
  assert.equal(result.body, body)
})

test('rewriteServiceInBody returns original when body is not a JSON object', () => {
  const body = new TextEncoder().encode('"just a string"')
  const result = rewriteServiceInBody(body, jsonHeaders, 'new-model')
  assert.equal(result.body, body)
})
