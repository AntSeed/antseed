import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import { DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS } from '../config/defaults.js'
import {
  BuyerProxy,
  MODEL_VERIFICATION_MAX_AGE_MS,
  parsePeerPinnedService,
  parsePersistedPeers,
  rewritePeerPinnedServiceInBody,
  selectCandidatePeersForRouting,
} from './buyer-proxy.js'

function makePeer(seed: string, providers: string[]): PeerInfo {
  const repeated = (seed.repeat(40) + 'a'.repeat(40)).slice(0, 40)
  return {
    peerId: repeated as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers,
  }
}

function makeProxyRequest(options: {
  method?: string
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
  req.method = options.method ?? 'POST'
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

function makeBuyerProxyWithPeers(initialPeers: PeerInfo[], refreshedPeers = initialPeers, router: unknown = null): BuyerProxy {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: {
      router,
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

test('BuyerProxy defaults to the configured 5 min background refresh interval', () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
  })

  assert.equal((proxy as any)._bgRefreshIntervalMs, DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS)
})

test('BuyerProxy accepts a custom background refresh interval', () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
    backgroundRefreshIntervalMs: 15_000,
  })

  assert.equal((proxy as any)._bgRefreshIntervalMs, 15_000)
})

test('BuyerProxy starts incremental discovery on startup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-proxy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let sweepCalls = 0
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: {
      router: null,
      on: () => undefined,
      startBackgroundPeerDiscoverySweep: () => { sweepCalls += 1 },
    } as any,
    backgroundRefreshIntervalMs: 60 * 60_000,
  })
  ;(proxy as any)._refreshPeersNow = async () => []

  await proxy.start()
  await proxy.stop()

  assert.equal(sweepCalls, 1)
})

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
  assert.match(res.body, /is not reachable right now/)
  assert.match(res.body, /It may be offline, not announcing, or temporarily unreachable/)
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
  assert.match(res.body, /does not offer provider=openai/)
  assert.match(res.body, /Available providers: local-llm/)
  assert.match(res.body, /x-antseed-provider header/)
})

test('pinned proxy request reports protocol or service mismatch when provider is available', async () => {
  const pinnedPeer = makePeer('a', ['local-llm'])
  pinnedPeer.providerServiceApiProtocols = {
    'local-llm': {
      services: {
        llama: ['openai-completions'],
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
  assert.match(res.body, /does not support this request/)
  assert.match(res.body, /provider=local-llm/)
  assert.match(res.body, /protocol=openai-responses/)
})

test('pinned proxy request enforces buyer routing policy', async () => {
  const pinnedPeer = makePeer('a', ['openai'])
  const router = {
    allowsPeerForPolicy: () => false,
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer], [pinnedPeer], router)
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': pinnedPeer.peerId,
    },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /outside your buyer routing policy/)
  assert.match(res.body, /pricing\/reputation limits/)
})

test('local buyer payment failures only update diagnostic failure state', async () => {
  const peer = makePeer('a', ['openai'])
  const routerResults: unknown[] = []
  const router = {
    allowsPeerForPolicy: () => true,
    onResult: (_peer: PeerInfo, result: unknown) => {
      routerResults.push(result)
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], router)
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Insufficient buyer deposits for reserve top-up: available=0 required=1000')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': peer.peerId,
    },
  }))

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /Insufficient buyer deposits/)
  assert.equal(routerResults.length, 0)
  assert.equal((proxy as any)._peerFailures.get(peer.peerId)?.count, 1)
  assert.equal((proxy as any)._peerFailures.get(peer.peerId)?.lastReason, 'request-failed')
  assert.equal((proxy as any)._cachedPeers[0]?.peerId, peer.peerId)
})

test('transport failures only update diagnostic failure state', async () => {
  const peer = makePeer('a', ['openai'])
  const routerResults: Array<{ success: boolean }> = []
  const router = {
    allowsPeerForPolicy: () => true,
    onResult: (_peer: PeerInfo, result: { success: boolean }) => {
      routerResults.push(result)
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], router)
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Request abc123 timed out')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': peer.peerId,
    },
  }))

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /Request abc123 timed out/)
  assert.equal(routerResults.length, 0)
  assert.equal((proxy as any)._peerFailures.get(peer.peerId)?.count, 1)
  assert.equal((proxy as any)._peerFailures.get(peer.peerId)?.lastReason, 'request-failed')
  assert.equal((proxy as any)._cachedPeers[0]?.peerId, peer.peerId)
})

test('/v1/models retryable response reports router success', async () => {
  const peer = makePeer('a', ['openai'])
  const routerResults: Array<{ success: boolean }> = []
  const router = {
    allowsPeerForPolicy: () => true,
    onResult: (_peer: PeerInfo, result: { success: boolean }) => {
      routerResults.push(result)
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], router)
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 500,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('model probe failed'),
  })

  const res = await invokeProxy(proxy, makeProxyRequest({
    method: 'GET',
    path: '/v1/models',
    headers: {
      'x-antseed-pin-peer': peer.peerId,
    },
  }))

  assert.equal(res.statusCode, 500)
  assert.match(res.body, /model probe failed/)
  assert.equal(routerResults.length, 1)
  assert.equal(routerResults[0]?.success, true)
})

test('model peer prefix pins the request peer and strips the routed model', async () => {
  const pinnedPeer = makePeer('a', ['openai'])
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedPeerId: string | null = null
  const router = {
    allowsPeerForPolicy: (req: { body: Uint8Array }, peer: PeerInfo) => {
      capturedRequestBody = parseJsonBody(req.body)
      capturedPeerId = peer.peerId
      return false
    },
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer], [pinnedPeer], router)
  const req = makeProxyRequest({
    body: { model: `${pinnedPeer.peerId}@gpt-4o`, messages: [] },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.equal(capturedPeerId, pinnedPeer.peerId)
  assert.equal(capturedRequestBody?.['model'], 'gpt-4o')
  assert.equal(capturedRequestBody?.['service'], 'gpt-4o')
})

test('x-antseed-pin-peer header takes precedence over model peer prefix', async () => {
  const modelPinnedPeer = makePeer('a', ['openai'])
  const headerPinnedPeer = makePeer('b', ['openai'])
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedPeerId: string | null = null
  const router = {
    allowsPeerForPolicy: (req: { body: Uint8Array }, peer: PeerInfo) => {
      capturedRequestBody = parseJsonBody(req.body)
      capturedPeerId = peer.peerId
      return false
    },
  }
  const proxy = makeBuyerProxyWithPeers([modelPinnedPeer, headerPinnedPeer], [modelPinnedPeer, headerPinnedPeer], router)
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': headerPinnedPeer.peerId,
    },
    body: { model: `${modelPinnedPeer.peerId}@gpt-4o`, messages: [] },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.equal(capturedPeerId, headerPinnedPeer.peerId)
  assert.equal(capturedRequestBody?.['model'], 'gpt-4o')
  assert.equal(capturedRequestBody?.['service'], 'gpt-4o')
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
        capabilities: ['verification.response-auth.v1'],
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
  assert.deepEqual(peer!.capabilities, ['verification.response-auth.v1'])
  assert.deepEqual(peer!.metadata?.capabilities, ['verification.response-auth.v1'])
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

test('parsePersistedPeers restores external verification claims and results', () => {
  const verificationResults = {
    verified: true,
    checkedAtMs: NOW - 500,
    domains: [
      {
        domain: 'example.com',
        peerId: validPeerId,
        verified: true,
        method: 'dns-txt',
        checkedAtMs: NOW - 500,
        attempts: [{ method: 'dns-txt', verified: true }],
      },
    ],
    github: [],
  }
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 1_000,
          verifications: {
            domains: [{ domain: 'example.com', methods: ['dns-txt'] }],
          },
          verificationResults,
        },
      ],
    },
    NOW,
  )
  assert.ok(peer)
  assert.deepEqual(peer!.metadata?.verifications, {
    domains: [{ domain: 'example.com', methods: ['dns-txt'] }],
  })
  assert.deepEqual(peer!.verificationResults, verificationResults)
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

// peer-pinned model syntax tests

function makeJsonBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

function parseJsonBody(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
}

const jsonHeaders: Record<string, string> = { 'content-type': 'application/json' }

test('parsePeerPinnedService parses 40-char hex peer prefixes', () => {
  assert.deepEqual(parsePeerPinnedService(`${validPeerId}@claude-sonnet-4-5`), {
    peerId: validPeerId,
    service: 'claude-sonnet-4-5',
  })
  assert.deepEqual(parsePeerPinnedService(`0x${validPeerId.toUpperCase()}@gpt-4o`), {
    peerId: validPeerId,
    service: 'gpt-4o',
  })
})

test('parsePeerPinnedService ignores non-peer model paths', () => {
  assert.equal(parsePeerPinnedService('openai/gpt-4o'), null)
  assert.equal(parsePeerPinnedService('openai@gpt-4o'), null)
  assert.equal(parsePeerPinnedService(`${validPeerId}@`), null)
  assert.equal(parsePeerPinnedService(`@${validPeerId}`), null)
})

test('rewritePeerPinnedServiceInBody strips model peer prefix and sets service', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, messages: [] })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(result.pinnedPeerId, validPeerId)
  assert.equal(parsed['service'], 'gpt-4o')
  assert.equal(parsed['model'], 'gpt-4o')
})

test('rewritePeerPinnedServiceInBody strips service peer prefix when model is absent', () => {
  const body = makeJsonBody({ service: `${validPeerId}@gpt-4o`, messages: [] })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(result.pinnedPeerId, validPeerId)
  assert.equal(parsed['service'], 'gpt-4o')
  assert.equal(parsed['model'], 'gpt-4o')
})

test('rewritePeerPinnedServiceInBody preserves explicit unprefixed service when model is prefixed', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, service: 'custom-service', messages: [] })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(result.pinnedPeerId, validPeerId)
  assert.equal(parsed['model'], 'gpt-4o')
  assert.equal(parsed['service'], 'custom-service')
})

test('rewritePeerPinnedServiceInBody preserves all other fields', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'gpt-4o')
  assert.equal(parsed['model'], 'gpt-4o')
  assert.deepEqual(parsed['messages'], [{ role: 'user', content: 'hi' }])
  assert.equal(parsed['max_tokens'], 1024)
})

test('rewritePeerPinnedServiceInBody updates content-length header when present', () => {
  const original = makeJsonBody({ model: `${validPeerId}@gpt-4o`, messages: [] })
  const headers = { 'content-type': 'application/json', 'content-length': String(original.length) }
  const result = rewritePeerPinnedServiceInBody(original, headers)
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('rewritePeerPinnedServiceInBody returns original when body is not JSON content-type', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o` })
  const headers = { 'content-type': 'text/plain' }
  const result = rewritePeerPinnedServiceInBody(body, headers)
  assert.equal(result.body, body)
  assert.equal(result.headers, headers)
  assert.equal(result.pinnedPeerId, null)
})

test('rewritePeerPinnedServiceInBody returns original when body is empty', () => {
  const body = new Uint8Array(0)
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  assert.equal(result.body, body)
  assert.equal(result.pinnedPeerId, null)
})

test('rewritePeerPinnedServiceInBody returns original when body is not a JSON object', () => {
  const body = new TextEncoder().encode('"just a string"')
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  assert.equal(result.body, body)
  assert.equal(result.pinnedPeerId, null)
})

// Substitution-flag routing gate — the CLI buyer path is pinned-peer-only, so
// the exclusion DefaultRouter applies during selection is enforced here on the
// pinned peer itself (pins are deliberately gated: an explicit pin means
// "I want this peer", not "I accept a substituted model").

// A CORROBORATED flag: >= 2 distinct verifiers currently stand by a DIFF, the
// same bar the on-chain emissions penalty gates on. Only this level of
// corroboration excludes; a single accuser (SINGLE_ACCUSER_STATS) does not.
const FLAGGED_STATS = {
  sameCount: 1,
  diffCount: 3,
  undeterminedCount: 0,
  distinctVerifierCount: 2,
  activeDiffVerifierCount: 2,
  lastVerdict: 2,
  score: 10,
}

// One verifier alone stands by a DIFF: not enough to exclude (that would make a
// single wrong/malicious verifier a routing kill-switch). Deprioritizes only.
const SINGLE_ACCUSER_STATS = {
  sameCount: 1,
  diffCount: 1,
  undeterminedCount: 0,
  distinctVerifierCount: 1,
  activeDiffVerifierCount: 1,
  lastVerdict: 2,
  score: 20,
}

const CLEAN_STATS = {
  sameCount: 5,
  diffCount: 0,
  undeterminedCount: 0,
  distinctVerifierCount: 3,
  activeDiffVerifierCount: 0,
  lastVerdict: 1,
  score: 88,
}

// Historical DIFFs with no standing accuser (every accusing verifier
// re-attested SAME) must not block routing — only lower the score ceiling.
const RETRACTED_STATS = {
  sameCount: 4,
  diffCount: 2,
  undeterminedCount: 0,
  distinctVerifierCount: 3,
  activeDiffVerifierCount: 0,
  lastVerdict: 1,
  score: 60,
}

function makeDispatchCountingProxy(peer: PeerInfo): { proxy: BuyerProxy; dispatched: () => number } {
  const proxy = makeBuyerProxyWithPeers([peer], [peer], { allowsPeerForPolicy: () => true, onResult: () => undefined })
  let dispatchCount = 0
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => {
    dispatchCount += 1
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"ok":true}'),
    }
  }
  return { proxy, dispatched: () => dispatchCount }
}

test('pinned peer with an active substitution flag for the requested service is blocked', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { 'gpt-4o': FLAGGED_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now()
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /model-substitution flag/)
  assert.match(res.body, /gpt-4o/)
  assert.equal(dispatched(), 0, 'no request may be dispatched to a flagged peer')
})

test('a single standing DIFF (one verifier) does NOT block the pinned peer — corroboration required', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { 'gpt-4o': SINGLE_ACCUSER_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now()
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(dispatched(), 1, 'a lone accuser must not blackball an honest seller')
})

test('clean pinned peer is dispatched; a flag on a different service does not block', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = {
    'other-model': FLAGGED_STATS,
    'gpt-4o': CLEAN_STATS,
  }
  ;(peer as any).modelVerificationFetchedAt = Date.now()
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(dispatched(), 1, 'clean peer must be dispatched')
})

test('substitution gate falls back to the agent-wide aggregate when per-service stats are missing', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { '*': FLAGGED_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now()
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /model-substitution flag/)
  assert.equal(dispatched(), 0)
})

test('retracted substitution flag (no standing accuser) does not block routing', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { 'gpt-4o': RETRACTED_STATS, '*': RETRACTED_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now()
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(dispatched(), 1)
})

test('peers with no verification data are unaffected by the substitution gate', async () => {
  const peer = makePeer('a', ['openai'])
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(dispatched(), 1)
})

test('GET /v1/models service listing is exempt from the substitution gate', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { '*': FLAGGED_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now()
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    method: 'GET',
    path: '/v1/models',
    headers: { 'x-antseed-pin-peer': peer.peerId },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(dispatched(), 1, 'flagged peers must remain inspectable via /v1/models')
})

// Minor 2: the /v1/models exemption is scoped to GET on the exact listing
// path. A POST to /v1/models is not the read-only control-plane surface, so a
// flagged peer must NOT be exempt from the substitution gate for it.
test('POST /v1/models on a flagged peer is NOT exempt from the substitution gate', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { '*': FLAGGED_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now()
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    method: 'POST',
    path: '/v1/models',
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /model-substitution flag/)
  assert.equal(dispatched(), 0, 'a POST to /v1/models must not bypass the gate on a flagged peer')
})

// F3: a persisted/cached DIFF flag carries a freshness stamp so it ages out.
// Enrichment only overwrites modelVerification on a successful registry read,
// so without a TTL a stale flag (registry since unconfigured, or enrichment
// permanently RPC-failing) would block a peer forever even after its accusers
// retract. Past MODEL_VERIFICATION_MAX_AGE_MS the gate treats it as absent.
test('a stale persisted substitution flag past max-age does NOT block routing', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { 'gpt-4o': FLAGGED_STATS, '*': FLAGGED_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now() - (MODEL_VERIFICATION_MAX_AGE_MS + 60_000)
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 200, 'a flag older than the max age must not block')
  assert.equal(dispatched(), 1)
})

test('a fresh substitution flag within max-age still blocks routing', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { 'gpt-4o': FLAGGED_STATS, '*': FLAGGED_STATS }
  ;(peer as any).modelVerificationFetchedAt = Date.now() - (MODEL_VERIFICATION_MAX_AGE_MS - 60_000)
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /model-substitution flag/)
  assert.equal(dispatched(), 0)
})

// A flag with no freshness stamp at all (pre-upgrade on-disk row, or any
// unstamped source) is treated as absent — fail-open on the liveness side,
// self-healing on the next enrichment pass which re-stamps it.
test('a substitution flag with no freshness stamp does NOT block routing', async () => {
  const peer = makePeer('a', ['openai'])
  peer.modelVerification = { '*': FLAGGED_STATS }
  const { proxy, dispatched } = makeDispatchCountingProxy(peer)

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: { model: 'gpt-4o', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(dispatched(), 1)
})

test('parsePersistedPeers round-trips a fresh modelVerification so the gate works from the warm cache', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 5_000,
          modelVerification: { 'gpt-4o': FLAGGED_STATS, '*': CLEAN_STATS },
          modelVerificationFetchedAt: NOW - 5_000,
        },
        {
          peerId: 'b'.repeat(40),
          providers: ['openai'],
          lastSeen: NOW - 5_000,
          modelVerification: 'junk',
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[0]?.modelVerification, { 'gpt-4o': FLAGGED_STATS, '*': CLEAN_STATS })
  assert.equal((result[0] as any)?.modelVerificationFetchedAt, NOW - 5_000)
  assert.equal(result[1]?.modelVerification, undefined)
})

test('parsePersistedPeers drops a stale modelVerification (past max-age) on rehydration', () => {
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 5_000,
          lastReachedAt: NOW - 5_000,
          modelVerification: { '*': FLAGGED_STATS },
          modelVerificationFetchedAt: NOW - (MODEL_VERIFICATION_MAX_AGE_MS + 60_000),
        },
      ],
    },
    NOW,
  )
  // Peer itself survives (recently reached), but the stale flag is dropped so a
  // since-unconfigured verifier registry can't block it forever.
  assert.equal(peer?.peerId, validPeerId)
  assert.equal(peer?.modelVerification, undefined)
  assert.equal((peer as any)?.modelVerificationFetchedAt, undefined)
})

test('parsePersistedPeers drops modelVerification with no freshness stamp on rehydration', () => {
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 5_000,
          modelVerification: { '*': FLAGGED_STATS },
        },
      ],
    },
    NOW,
  )
  assert.equal(peer?.modelVerification, undefined)
})
