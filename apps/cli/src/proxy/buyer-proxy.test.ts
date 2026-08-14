import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { Readable } from 'node:stream'
import test from 'node:test'
import { CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1, type PeerInfo, type SerializedHttpResponse } from '@antseed/node'
import { DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS } from '../config/defaults.js'
import {
  BuyerProxy,
  isModelNotFoundResponse,
  makeVerifierReach,
  mergeJsonStateFile,
  parsePeerPinnedService,
  parsePersistedPeers,
  rewritePeerPinnedServiceInBody,
  selectCandidatePeersForRouting,
  substituteRoutedModelAlias,
  sweepStaleStateTmpFiles,
  parseRoutedModelSelection,
  rewriteRoutedModelSelection,
} from './buyer-proxy.js'
import { parseApplicationRouteMap } from './application-routes.js'
import {
  overrideRoutedModelInBody,
  rewriteRequestedModelInBody,
  stripPrivateRequestHeaders,
  SYSTEM_ROUTED_MODEL_HEADER,
} from './request-utils.js'

function makePeer(seed: string, providers: string[]): PeerInfo {
  const repeated = (seed.repeat(40) + 'a'.repeat(40)).slice(0, 40)
  return {
    peerId: repeated as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers,
  }
}

function makeServicePeer(seed: string, provider: string, services: string[]): PeerInfo {
  const peer = makePeer(seed, [provider])
  peer.providerServiceApiProtocols = {
    [provider]: {
      services: Object.fromEntries(services.map((service) => [service, ['openai-responses']])),
    },
  } as PeerInfo['providerServiceApiProtocols']
  peer.providerPricing = {
    [provider]: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      services: Object.fromEntries(services.map((service) => [service, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }])),
    },
  }
  return peer
}

async function makeApplicationRouteProxy(peers: PeerInfo[]): Promise<{
  proxy: BuyerProxy
  dir: string
  dispatched: Array<{ peerId: string; body: Record<string, unknown>; headers: Record<string, string> }>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-app-routes-'))
  const dispatched: Array<{ peerId: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: {
      router: {
        selectPeer: (_request: unknown, candidates: PeerInfo[]) => candidates[0] ?? null,
        onResult: () => undefined,
      },
      sendRequest: async (peer: PeerInfo, request: { requestId: string; body: Uint8Array; headers: Record<string, string> }) => {
        dispatched.push({
          peerId: peer.peerId,
          body: JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, unknown>,
          headers: request.headers,
        })
        return {
          requestId: request.requestId,
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{}'),
        }
      },
    } as any,
  })
  ;(proxy as any)._getPeers = async () => peers
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  return { proxy, dir, dispatched }
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
  write: (chunk: string | Buffer | Uint8Array) => unknown
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
    write(chunk: string | Buffer | Uint8Array) {
      this.body += Buffer.from(chunk).toString('utf8')
      return true
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

test('stripPrivateRequestHeaders removes credentials case-insensitively and retains API headers', () => {
  const stripped = stripPrivateRequestHeaders({
    Authorization: 'Bearer secret',
    'PROXY-AUTHORIZATION': 'Basic secret',
    'X-API-KEY': 'secret',
    'X-Goog-Api-Key': 'secret',
    'ChatGPT-Account-Id': 'account-secret',
    Cookie: 'session=secret',
    'X-CSRF-Token': 'secret',
    'OpenAI-Organization': 'org-secret',
    'X-OpenAI-Project': 'project-secret',
    Connection: 'keep-alive, X-Internal-Hop',
    'X-Internal-Hop': 'secret',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=v1',
    'X-Stainless-Lang': 'js',
  })

  assert.deepEqual(stripped, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'openai-beta': 'responses=v1',
    'x-stainless-lang': 'js',
  })
})

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

test('BuyerProxy rejects Responses WebSocket upgrades with the Codex HTTP fallback status', async () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
  })
  const server = (proxy as any)._server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1')
      let data = ''
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write([
        'GET /v1/responses HTTP/1.1',
        `Host: 127.0.0.1:${address.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n')))
      socket.on('data', (chunk) => {
        data += chunk
        if (!data.includes('\r\n\r\n')) return
        socket.destroy()
        resolve(data)
      })
      socket.on('error', reject)
    })

    assert.match(response, /^HTTP\/1\.1 426 Upgrade Required\r\n/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
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

test('sweep control endpoint validates and dispatches sequentially via the running node', async () => {
  const validSweep = {
    version: 1,
    evmChainId: 31337,
    relayAddress: '0x' + '8a'.repeat(20),
    from: '0x' + '11'.repeat(20),
    amount: '5000000',
    validAfter: 0,
    validBefore: 2_000_000_000,
    nonce: '0x' + 'aa'.repeat(32),
    sig3009: '0x' + 'ab'.repeat(65),
  }

  const dispatches: unknown[] = []
  const listeners = new Map<string, (event: unknown) => void>()
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: {
      router: null,
      on: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener),
      dispatchSweepRequest: async (payload: unknown) => {
        dispatches.push(payload)
        return { offered: 3, accepted: true }
      },
    } as any,
  })

  const res = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/sweep', body: validSweep }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, sent: 3, accepted: true })
  assert.equal(dispatches.length, 1)

  // Malformed payloads are rejected by the wire codec, not dispatched.
  const bad = await invokeProxy(proxy, makeProxyRequest({
    path: '/_antseed/sweep',
    body: { ...validSweep, sig3009: 'garbage' },
  }))
  assert.equal(bad.statusCode, 400)
  assert.equal(dispatches.length, 1)

  // Receipts surfaced via node events are readable per-nonce.
  const emit = listeners.get('sweep:receipt')
  assert.ok(emit, 'proxy subscribes to sweep:receipt')
  emit!({ peerId: 'p1', payload: { version: 1, authNonce: validSweep.nonce, status: 'confirmed', txHash: '0x' + '77'.repeat(32) } })

  const receiptRes = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: `/_antseed/sweep/${validSweep.nonce}` }))
  assert.equal(receiptRes.statusCode, 200)
  const receiptBody = JSON.parse(receiptRes.body) as { ok: boolean; receipt: { status: string; txHash: string } }
  assert.equal(receiptBody.receipt.status, 'confirmed')
  assert.equal(receiptBody.receipt.txHash, '0x' + '77'.repeat(32))

  // Unknown nonce returns null receipt.
  const missing = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: `/_antseed/sweep/0x${'bb'.repeat(32)}` }))
  assert.deepEqual(JSON.parse(missing.body), { ok: true, receipt: null })
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

test('peers control endpoint exposes relay capability metadata', async () => {
  const peer = makePeer('a', ['openai'])
  peer.capabilities = [CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1]
  const proxy = makeBuyerProxyWithPeers([peer])

  const res = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/peers' }))
  const body = JSON.parse(res.body) as { peers: Array<{ capabilities: string[] }> }

  assert.equal(res.statusCode, 200)
  assert.deepEqual(body.peers[0]?.capabilities, [CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1])
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

test('unpinned explicit model routes through only explicitly advertising compatible peers', async () => {
  const eligible = makePeer('a', ['openai-responses'])
  eligible.providerServiceApiProtocols = { 'openai-responses': { services: { 'gpt-5.4': ['openai-responses'] } } }
  eligible.providerPricing = { 'openai-responses': { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'gpt-5.4': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } }
  const wrongModel = makePeer('b', ['openai-responses'])
  wrongModel.providerServiceApiProtocols = { 'openai-responses': { services: { 'gpt-4o': ['openai-responses'] } } }
  wrongModel.providerPricing = { 'openai-responses': { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'gpt-4o': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } }
  let selectedCandidates: PeerInfo[] = []
  let dispatchedPeerId: string | null = null
  let dispatchedHeaders: Record<string, string> | null = null
  const router = {
    selectPeer: (_request: unknown, peers: PeerInfo[]) => {
      selectedCandidates = peers
      return peers[0] ?? null
    },
    onResult: () => undefined,
  }
  const proxy = makeBuyerProxyWithPeers([wrongModel, eligible], [wrongModel, eligible], router)
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string; headers: Record<string, string> }) => {
    dispatchedPeerId = peer.peerId
    dispatchedHeaders = request.headers
    return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/responses',
    headers: {
      Authorization: 'Bearer secret',
      'X-API-KEY': 'secret',
      Cookie: 'session=secret',
      'OpenAI-Project': 'project-secret',
      'OpenAI-Beta': 'responses=v1',
    },
    body: { model: 'GPT-5.4', input: 'hello' },
  }))

  assert.equal(res.statusCode, 200)
  assert.deepEqual(selectedCandidates.map((peer) => peer.peerId), [eligible.peerId])
  assert.equal(dispatchedPeerId, eligible.peerId)
  assert.equal(dispatchedHeaders?.['authorization'], undefined)
  assert.equal(dispatchedHeaders?.['x-api-key'], undefined)
  assert.equal(dispatchedHeaders?.['cookie'], undefined)
  assert.equal(dispatchedHeaders?.['openai-project'], undefined)
  assert.equal(dispatchedHeaders?.['openai-beta'], 'responses=v1')
})

test('automatic conversation routing is sticky per model and reselects on model change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-auto-sticky-'))
  const first = makePeer('a', ['openai-responses'])
  const second = makePeer('b', ['openai-responses'])
  for (const peer of [first, second]) {
    peer.providerServiceApiProtocols = { 'openai-responses': { services: {
      'gpt-5.4': ['openai-responses'],
      'gpt-5.5': ['openai-responses'],
    } } }
    peer.providerPricing = { 'openai-responses': { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: {
      'gpt-5.4': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      'gpt-5.5': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    } } }
  }
  let broadSelections = 0
  const candidateSets: string[][] = []
  const dispatched: string[] = []
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: {
      router: {
        selectPeer: (_request: unknown, peers: PeerInfo[]) => {
          candidateSets.push(peers.map((peer) => peer.peerId))
          if (peers.length === 1) return peers[0] ?? null
          return peers[broadSelections++ % peers.length] ?? null
        },
        onResult: () => undefined,
      },
      sendRequest: async (peer: PeerInfo, request: { requestId: string }) => {
        dispatched.push(peer.peerId)
        return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }
      },
    } as any,
  })
  ;(proxy as any)._getPeers = async () => [first, second]
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  t.after(async () => {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  })
  const request = (model: string) => makeProxyRequest({
    path: '/v1/responses',
    headers: { originator: 'codex_exec', 'session-id': 'sticky-session' },
    body: { model, input: 'hello' },
  })

  await invokeProxy(proxy, request('gpt-5.4'))
  await invokeProxy(proxy, request('gpt-5.4'))
  await invokeProxy(proxy, request('gpt-5.5'))

  assert.equal(broadSelections, 2)
  assert.deepEqual(candidateSets, [
    [first.peerId, second.peerId],
    [first.peerId],
    [first.peerId, second.peerId],
  ])
  assert.deepEqual(dispatched, [first.peerId, first.peerId, second.peerId])
  assert.equal((proxy as any)._conversations.get('codex-exec:sticky-session')?.automaticService, 'gpt-5.5')
})

test('unpinned explicit model refreshes once and returns a structured no-peer error', async () => {
  const proxy = makeBuyerProxyWithPeers([], [])
  let refreshes = 0
  ;(proxy as any)._getPeers = async (options?: { forceRefresh?: boolean }) => {
    if (options?.forceRefresh) refreshes += 1
    return []
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/responses',
    body: { model: 'missing-model', input: 'hello' },
  }))
  const body = JSON.parse(res.body) as { error: { code: string; model: string } }

  assert.equal(res.statusCode, 503)
  assert.equal(refreshes, 1)
  assert.equal(body.error.code, 'no_eligible_model_peers')
  assert.equal(body.error.model, 'missing-model')
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

test('pinned proxy reconciles a stale provider when the exact service has one provider', async () => {
  const pinnedPeer = makeServicePeer('a', 'openai-responses', ['gpt-5.6-sol'])
  let outboundProvider: string | undefined
  const router = {
    selectPeer: (_request: unknown, peers: PeerInfo[]) => peers[0] ?? null,
    onResult: () => undefined,
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer], [pinnedPeer], router)
  ;(proxy as any)._node.sendRequest = async (
    _peer: PeerInfo,
    request: { requestId: string; headers: Record<string, string> },
  ) => {
    outboundProvider = request.headers['x-antseed-provider']
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/responses',
    headers: {
      'x-antseed-pin-peer': pinnedPeer.peerId,
      'x-antseed-provider': 'openai',
    },
    body: { model: 'gpt-5.6-sol', input: 'hello' },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(outboundProvider, 'openai-responses')
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

test('responses custom tools survive Chat-only peer request and response adaptation', async () => {
  const peer = makePeer('a', ['openai'])
  peer.providerServiceApiProtocols = {
    openai: {
      services: {
        'claude-opus-5': ['openai-chat-completions'],
      },
    },
  }
  let capturedRequestBody: Record<string, unknown> | null = null
  const proxy = makeBuyerProxyWithPeers([peer], [peer])
  ;(proxy as any)._node.sendRequest = async (
    _peer: PeerInfo,
    request: { requestId: string; body: Uint8Array },
  ) => {
    capturedRequestBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        id: 'chatcmpl-custom',
        model: 'claude-opus-5',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_shell_1',
              type: 'function',
              function: { name: 'shell_command', arguments: '{"input":"pwd"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/responses',
    headers: { 'x-antseed-pin-peer': peer.peerId },
    body: {
      model: 'claude-opus-5',
      input: 'run pwd',
      tools: [{ type: 'custom', name: 'shell_command' }],
    },
  }))

  assert.equal(res.statusCode, 200)
  assert.ok(capturedRequestBody)
  const outboundTools = capturedRequestBody['tools'] as Array<{ function: { name: string } }>
  assert.equal(outboundTools[0]?.function.name, 'shell_command')
  const body = JSON.parse(res.body) as { output: Array<Record<string, unknown>> }
  assert.deepEqual(body.output[0], {
    type: 'custom_tool_call',
    id: 'call_shell_1',
    call_id: 'call_shell_1',
    name: 'shell_command',
    input: 'pwd',
  })
})

test('non-stream transformed responses requests force upstream stream without streaming to client', async () => {
  const peer = makePeer('a', ['openai-responses'])
  peer.providerServiceApiProtocols = {
    'openai-responses': {
      services: {
        'gpt-5.6-sol': ['openai-responses'],
      },
    },
  }
  let sendRequestCalls = 0
  let sendRequestStreamCalls = 0
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedRequestHeaders: Record<string, string> | null = null
  const proxy = makeBuyerProxyWithPeers([peer], [peer])
  ;(proxy as any)._node.sendRequest = async (
    _peer: PeerInfo,
    request: { requestId: string; body: Uint8Array; headers: Record<string, string> },
  ) => {
    sendRequestCalls += 1
    capturedRequestBody = parseJsonBody(request.body)
    capturedRequestHeaders = request.headers
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.6-sol',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })),
    }
  }
  ;(proxy as any)._node.sendRequestStream = async () => {
    sendRequestStreamCalls += 1
    throw new Error('sendRequestStream should not be used')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/messages',
    headers: {
      'x-antseed-pin-peer': peer.peerId,
    },
    body: {
      model: 'gpt-5.6-sol',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(sendRequestCalls, 1)
  assert.equal(sendRequestStreamCalls, 0)
  assert.equal(capturedRequestBody?.['stream'], true)
  assert.equal(capturedRequestHeaders?.['x-antseed-client-stream-requested'], 'false')
  const body = JSON.parse(res.body) as { content?: Array<{ type: string; text: string }> }
  assert.equal(body.content?.[0]?.text, 'hi')
})

test('accept-sse transformed responses requests stream adapted client events without body stream flag', async () => {
  const peer = makePeer('a', ['openai-responses'])
  peer.providerServiceApiProtocols = {
    'openai-responses': {
      services: {
        'gpt-5.6-sol': ['openai-responses'],
      },
    },
  }
  let sendRequestCalls = 0
  let sendRequestStreamCalls = 0
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedRequestHeaders: Record<string, string> | null = null
  const proxy = makeBuyerProxyWithPeers([peer], [peer])
  ;(proxy as any)._node.sendRequest = async () => {
    sendRequestCalls += 1
    throw new Error('sendRequest should not be used')
  }
  ;(proxy as any)._node.sendRequestStream = async (
    _peer: PeerInfo,
    request: { requestId: string; body: Uint8Array; headers: Record<string, string> },
    callbacks: {
      onResponseStart: (response: { requestId: string; statusCode: number; headers: Record<string, string>; body: Uint8Array }, metadata: { streaming: boolean }) => void
      onResponseChunk: (chunk: { requestId: string; data: Uint8Array; done: boolean }) => void
    },
  ) => {
    sendRequestStreamCalls += 1
    capturedRequestBody = parseJsonBody(request.body)
    capturedRequestHeaders = request.headers
    callbacks.onResponseStart({
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(),
    }, { streaming: true })
    callbacks.onResponseChunk({
      requestId: request.requestId,
      data: Buffer.from(
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_1","object":"response","model":"gpt-5.6-sol","status":"in_progress","output":[],"output_text":"","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n'
        + 'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"hi","logprobs":[]}\n\n'
        + 'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-5.6-sol","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      ),
      done: false,
    })
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Buffer.from(''),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/messages',
    headers: {
      'accept': 'text/event-stream',
      'x-antseed-pin-peer': peer.peerId,
    },
    body: {
      model: 'gpt-5.6-sol',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(sendRequestCalls, 0)
  assert.equal(sendRequestStreamCalls, 1)
  assert.equal(capturedRequestBody?.['stream'], true)
  assert.equal(capturedRequestHeaders?.['x-antseed-client-stream-requested'], 'true')
  assert.match(res.body, /event: message_start/)
  assert.match(res.body, /event: content_block_delta/)
  assert.match(res.body, /"text":"hi"/)
  assert.doesNotMatch(res.body, /event: response\.completed/)
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

test('substituteRoutedModelAlias replaces the alias model with the default routed model', () => {
  const body = makeJsonBody({ model: 'antseed', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, `${validPeerId}@gpt-4o`)
  assert.equal(result.aliasRequested, true)
  assert.equal(result.substituted, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['model'], `${validPeerId}@gpt-4o`)
})

test('substituteRoutedModelAlias handles the alias in the service field and is case-insensitive', () => {
  const body = makeJsonBody({ service: 'AntSeed', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, `${validPeerId}@gpt-4o`)
  assert.equal(result.substituted, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], `${validPeerId}@gpt-4o`)
})

test('substituteRoutedModelAlias reports an unresolvable alias when no default route is set', () => {
  const body = makeJsonBody({ model: 'antseed', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, null)
  assert.equal(result.aliasRequested, true)
  assert.equal(result.substituted, false)
  assert.equal(result.body, body)
})

test('substituteRoutedModelAlias leaves non-alias models untouched', () => {
  const body = makeJsonBody({ model: 'gpt-4o', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, `${validPeerId}@gpt-4o`)
  assert.equal(result.aliasRequested, false)
  assert.equal(result.substituted, false)
  assert.equal(result.body, body)
})

test('parseRoutedModelSelection decodes provider and preserves slashes in the service', () => {
  assert.deepEqual(parseRoutedModelSelection('antseed/openai-responses/openai/gpt-5.6-sol'), {
    provider: 'openai-responses',
    service: 'openai/gpt-5.6-sol',
  })
  assert.equal(parseRoutedModelSelection('antseed'), null)
  assert.equal(parseRoutedModelSelection('gpt-5.6-sol'), null)
})

test('rewriteRoutedModelSelection replaces the catalog slug and updates content-length', () => {
  const body = makeJsonBody({ model: 'antseed/openai-responses/openai/gpt-5.6-sol', input: 'hello' })
  const result = rewriteRoutedModelSelection(body, {
    'content-type': 'application/json',
    'content-length': String(body.length),
  })
  assert.deepEqual(result.selection, { provider: 'openai-responses', service: 'openai/gpt-5.6-sol' })
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['model'], 'openai/gpt-5.6-sol')
  assert.equal(parsed['service'], 'openai/gpt-5.6-sol')
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('overrideRoutedModelInBody swaps the model, mirrors an identical service field, and fixes content-length', () => {
  const oldRoute = `${validPeerId}@gpt-4o`
  const newRoute = `${'bb'.repeat(20)}@glm-5`
  const body = makeJsonBody({ model: oldRoute, service: oldRoute, messages: [] })
  const headers = { ...jsonHeaders, 'content-length': String(body.length) }
  const result = overrideRoutedModelInBody(body, headers, newRoute)
  assert.equal(result.overridden, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['model'], newRoute)
  assert.equal(parsed['service'], newRoute)
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('overrideRoutedModelInBody leaves a differing service field alone', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, service: 'something-else', messages: [] })
  const result = overrideRoutedModelInBody(body, jsonHeaders, `${'bb'.repeat(20)}@glm-5`)
  assert.equal(result.overridden, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['model'], `${'bb'.repeat(20)}@glm-5`)
  assert.equal(parsed['service'], 'something-else')
})

test('overrideRoutedModelInBody no-ops on a matching model, a missing model, or non-JSON bodies', () => {
  const route = `${validPeerId}@gpt-4o`
  const matching = makeJsonBody({ model: route })
  assert.equal(overrideRoutedModelInBody(matching, jsonHeaders, route).overridden, false)
  const missing = makeJsonBody({ messages: [] })
  assert.equal(overrideRoutedModelInBody(missing, jsonHeaders, route).overridden, false)
  const nonJson = makeJsonBody({ model: 'other' })
  assert.equal(overrideRoutedModelInBody(nonJson, { 'content-type': 'text/plain' }, route).overridden, false)
})

test('rewriteRequestedModelInBody replaces both model and service fields', () => {
  const original = makeJsonBody({ model: 'old-model', service: 'old-service', messages: [] })
  const result = rewriteRequestedModelInBody(original, {
    'content-type': 'application/json',
    'content-length': String(original.length),
  }, 'new-model')
  const parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as Record<string, unknown>
  assert.equal(result.rewritten, true)
  assert.equal(parsed['model'], 'new-model')
  assert.equal(parsed['service'], 'new-model')
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('route control endpoint sets, persists, and returns the default routed model', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-route-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: { router: null } as any,
  })

  const set = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/route', body: { model: `${validPeerId}@gpt-4o` } }))
  assert.equal(set.statusCode, 200)
  assert.deepEqual(JSON.parse(set.body), { ok: true, model: `${validPeerId}@gpt-4o` })

  const get = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/route' }))
  assert.deepEqual(JSON.parse(get.body), { ok: true, model: `${validPeerId}@gpt-4o` })

  const persisted = JSON.parse(await readFile(join(dir, 'buyer.state.json'), 'utf-8')) as Record<string, unknown>
  assert.equal(persisted['defaultRoutedModel'], `${validPeerId}@gpt-4o`)

  const invalid = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/route', body: { model: 'gpt-4o' } }))
  assert.equal(invalid.statusCode, 400)

  const cleared = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/route', body: { model: '' } }))
  assert.deepEqual(JSON.parse(cleared.body), { ok: true, model: null })
})

test('application route endpoint atomically replaces and persists policies', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-app-route-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const proxy = new BuyerProxy({ port: 0, dataDir: dir, node: { router: null } as any })
  const routes = {
    codex: { mode: 'client-model', toolSlugs: ['codex'] },
    opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder', toolSlugs: ['opencode'] },
  }

  const set = await invokeProxy(proxy, makeProxyRequest({
    path: '/_antseed/application-routes',
    body: { routes },
  }))
  assert.equal(set.statusCode, 200)
  assert.deepEqual(Object.keys((proxy as any)._applicationRoutes).sort(), ['codex', 'opencode'])

  const persisted = JSON.parse(await readFile(join(dir, 'buyer.state.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(persisted['applicationRoutes'] as Record<string, unknown>).sort(), ['codex', 'opencode'])

  const reloaded = new BuyerProxy({ port: 0, dataDir: dir, node: { router: null } as any })
  await (reloaded as any)._reloadSessionOverrides()
  assert.deepEqual(Object.keys((reloaded as any)._applicationRoutes).sort(), ['codex', 'opencode'])

  const cleared = await invokeProxy(proxy, makeProxyRequest({
    path: '/_antseed/application-routes',
    body: { routes: {} },
  }))
  assert.equal(cleared.statusCode, 200)
  assert.deepEqual((proxy as any)._applicationRoutes, {})
})

test('Codex client-model policy preserves the model selected by the client', async () => {
  const peer = makeServicePeer('a', 'openai-responses', ['gpt-5.4'])
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([peer])
  try {
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      codex: { mode: 'client-model', toolSlugs: ['codex'] },
    })
    const response = await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex', 'session-id': 'codex-auto' },
      body: { model: 'gpt-5.4', input: 'hello' },
    }))

    assert.equal(response.statusCode, 200)
    assert.equal(dispatched[0]?.body['model'], 'gpt-5.4')
    assert.equal((proxy as any)._conversations.get('codex:codex-auto')?.applicationRoute, null)
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('namespaced picker models route without relying on client identity headers', async () => {
  const peer = makeServicePeer('a', 'openai', ['gpt-5.4'])
  peer.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5.4': ['openai-chat-completions'] } },
  }
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([peer])
  try {
    const response = await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      body: { model: 'antseed/openai/gpt-5.4', input: 'hello' },
    }))

    assert.equal(response.statusCode, 200)
    assert.equal(dispatched[0]?.body['model'], 'gpt-5.4')
    assert.equal(dispatched[0]?.headers['x-antseed-provider'], 'openai')
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Codex client-model policy routes namespaced picker models to the selected provider and service', async () => {
  const peer = makeServicePeer('a', 'openai-responses', ['openai/gpt-5.4'])
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([peer])
  try {
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      codex: { mode: 'client-model', toolSlugs: ['codex'] },
    })
    const response = await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex', 'session-id': 'codex-picker' },
      body: { model: 'antseed/openai-responses/openai/gpt-5.4', input: 'hello' },
    }))

    assert.equal(response.statusCode, 200)
    assert.equal(dispatched[0]?.body['model'], 'openai/gpt-5.4')
    assert.equal(dispatched[0]?.body['service'], 'openai/gpt-5.4')
    assert.equal(dispatched[0]?.headers['x-antseed-provider'], 'openai-responses')
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Codex peer-aware picker model overrides an unrelated global seller pin', async () => {
  const catGpt = makeServicePeer('a', 'openai-responses', ['gpt-5.6-sol'])
  const claudePeer = makeServicePeer('b', 'openai', ['claude-opus-5'])
  claudePeer.providerServiceApiProtocols = {
    openai: { services: { 'claude-opus-5': ['openai-chat-completions'] } },
  }
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([catGpt, claudePeer])
  try {
    ;(proxy as any)._pinnedPeer = catGpt.peerId
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      codex: { mode: 'client-model', toolSlugs: ['codex'] },
    })
    const response = await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex', 'session-id': 'codex-claude-picker' },
      body: {
        model: `antseed/openai/${claudePeer.peerId}@claude-opus-5`,
        input: 'hello',
      },
    }))

    assert.equal(response.statusCode, 200)
    assert.equal(dispatched[0]?.peerId, claudePeer.peerId)
    assert.equal(dispatched[0]?.body['model'], 'claude-opus-5')
    assert.equal(dispatched[0]?.headers['x-antseed-provider'], 'openai')
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('two application model policies override clients independently and restrict providers', async () => {
  const codexPeer = makeServicePeer('a', 'openai-responses', ['gpt-5.4'])
  const openCodePeer = makeServicePeer('b', 'openai-responses', ['qwen3-coder'])
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([codexPeer, openCodePeer])
  try {
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      codex: { mode: 'model', provider: 'openai-responses', service: 'gpt-5.4', toolSlugs: ['codex'] },
      opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder', toolSlugs: ['opencode'] },
    })

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex_exec', 'session-id': 'codex-explicit' },
      body: { model: 'antseed', input: 'hello' },
    }))
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: {
        'x-antseed-system-proxy-source': 'opencode',
        'user-agent': 'generic-sdk/1.0',
        'x-session-id': 'open-explicit',
      },
      body: { model: 'antseed', input: 'hello' },
    }))

    assert.deepEqual(dispatched.map((entry) => [entry.peerId, entry.body['model']]), [
      [codexPeer.peerId, 'gpt-5.4'],
      [openCodePeer.peerId, 'qwen3-coder'],
    ])
    assert.deepEqual(dispatched.map((entry) => entry.headers['x-antseed-provider']), [
      'openai-responses',
      'openai-responses',
    ])
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('OpenCode follow-global resolves the current global peer and service', async () => {
  const peer = makeServicePeer('a', 'openai-responses', ['gpt-5.4'])
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([peer])
  try {
    ;(proxy as any)._defaultRoutedModel = `${peer.peerId}@gpt-5.4`
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      opencode: { mode: 'follow-global', toolSlugs: ['opencode'] },
    })
    const response = await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'follow-default' },
      body: { model: 'antseed', input: 'hello' },
    }))

    assert.equal(response.statusCode, 200)
    assert.equal(dispatched[0]?.peerId, peer.peerId)
    assert.equal(dispatched[0]?.body['model'], 'gpt-5.4')
    assert.deepEqual((proxy as any)._conversations.get('opencode:follow-default')?.applicationRoute, {
      profileName: 'opencode',
      mode: 'follow-global',
      provider: null,
      service: 'gpt-5.4',
      peerId: peer.peerId,
    })
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('application route snapshots keep existing chats stable while new chats use later selections', async () => {
  const first = makeServicePeer('a', 'openai-responses', ['gpt-5.4'])
  const second = makeServicePeer('b', 'openai-responses', ['qwen3-coder'])
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([first, second])
  try {
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      opencode: { mode: 'model', provider: 'openai-responses', service: 'gpt-5.4', toolSlugs: ['opencode'] },
    })
    const request = (sessionKey: string) => makeProxyRequest({
      path: '/v1/responses',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': sessionKey },
      body: { model: 'antseed', input: 'hello' },
    })

    await invokeProxy(proxy, request('existing'))
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder', toolSlugs: ['opencode'] },
    })
    await invokeProxy(proxy, request('existing'))
    await invokeProxy(proxy, request('new-chat'))

    assert.deepEqual(dispatched.map((entry) => entry.body['model']), ['gpt-5.4', 'gpt-5.4', 'qwen3-coder'])
    assert.equal((proxy as any)._conversations.get('opencode:existing')?.applicationRoute?.service, 'gpt-5.4')
    assert.equal((proxy as any)._conversations.get('opencode:new-chat')?.applicationRoute?.service, 'qwen3-coder')
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('explicit application models keep Best sticky and fail over when the seller becomes ineligible', async () => {
  const first = makeServicePeer('a', 'openai-responses', ['gpt-5.4'])
  const second = makeServicePeer('b', 'openai-responses', ['gpt-5.4'])
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([first, second])
  let blockedPeerId: string | null = null
  const router = (proxy as any)._node.router as {
    selectPeer: (request: unknown, peers: PeerInfo[]) => PeerInfo | null
    allowsPeerForPolicy?: (request: unknown, peer: PeerInfo) => boolean
  }
  router.selectPeer = (_request, peers) => peers.find((peer) => peer.peerId !== blockedPeerId) ?? null
  router.allowsPeerForPolicy = (_request, peer) => peer.peerId !== blockedPeerId

  try {
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      opencode: { mode: 'model', provider: 'openai-responses', service: 'gpt-5.4', toolSlugs: ['opencode'] },
    })
    const request = () => makeProxyRequest({
      path: '/v1/responses',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'best-failover' },
      body: { model: 'antseed', input: 'hello' },
    })

    await invokeProxy(proxy, request())
    blockedPeerId = first.peerId
    await invokeProxy(proxy, request())

    assert.deepEqual(dispatched.map((entry) => entry.peerId), [first.peerId, second.peerId])
    assert.equal(
      (proxy as any)._conversations.get('opencode:best-failover')?.automaticRoute,
      `${second.peerId}@gpt-5.4`,
    )
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('title requests do not snapshot routes and subagents inherit the parent snapshot', async () => {
  const first = makeServicePeer('a', 'openai-responses', ['gpt-5.4'])
  const second = makeServicePeer('b', 'openai-responses', ['qwen3-coder'])
  const { proxy, dir, dispatched } = await makeApplicationRouteProxy([first, second])
  try {
    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      opencode: { mode: 'model', provider: 'openai-responses', service: 'gpt-5.4', toolSlugs: ['opencode'] },
    })
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'parent' },
      body: { model: 'antseed', messages: [{ role: 'user', content: 'Generate a title for this conversation:' }] },
    }))
    assert.equal((proxy as any)._conversations.get('opencode:parent'), null)

    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder', toolSlugs: ['opencode'] },
    })
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'parent' },
      body: { model: 'antseed', input: 'real prompt' },
    }))

    ;(proxy as any)._applicationRoutes = parseApplicationRouteMap({
      opencode: { mode: 'model', provider: 'openai-responses', service: 'gpt-5.4', toolSlugs: ['opencode'] },
    })
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: {
        'user-agent': 'opencode/1.0',
        'x-session-id': 'subagent',
        'x-parent-session-id': 'parent',
      },
      body: { model: 'antseed', input: 'subagent work' },
    }))

    assert.deepEqual(dispatched.map((entry) => entry.body['model']), ['gpt-5.4', 'qwen3-coder', 'qwen3-coder'])
    assert.equal((proxy as any)._conversations.get('opencode:parent')?.applicationRoute?.service, 'qwen3-coder')
  } finally {
    await (proxy as any)._conversations.flush()
    await rm(dir, { recursive: true, force: true })
  }
})

test('buyer-usage endpoint reports lastActivityAt, null until a request is dispatched', async () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null, getBuyerUsageTotals: () => ({ totalRequests: 0 }) } as any,
  })

  const before = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/buyer-usage' }))
  assert.equal(before.statusCode, 200)
  assert.equal((JSON.parse(before.body) as { lastActivityAt: number | null }).lastActivityAt, null)

  ;(proxy as any)._markModelActivity()

  const after = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/buyer-usage' }))
  const parsed = JSON.parse(after.body) as { ok: boolean; lastActivityAt: number | null }
  assert.equal(parsed.ok, true)
  assert.equal(typeof parsed.lastActivityAt, 'number')
  assert.ok((parsed.lastActivityAt ?? 0) > 0)
})

test('requests with the routed-model alias fail clearly when no default route is set', async () => {
  const proxy = makeBuyerProxyWithPeers([makePeer('a', ['openai'])])

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'antseed', messages: [] } }))
  assert.equal(res.statusCode, 400)
  const parsed = JSON.parse(res.body) as { error?: { code?: string } }
  assert.equal(parsed.error?.code, 'no_default_route')
})

test('substituteRoutedModelAlias updates content-length when substituting', () => {
  const original = makeJsonBody({ model: 'antseed', messages: [] })
  const headers = { 'content-type': 'application/json', 'content-length': String(original.length) }
  const result = substituteRoutedModelAlias(original, headers, `${validPeerId}@gpt-4o`)
  assert.equal(result.headers['content-length'], String(result.body.length))
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

// ---------- Per-chat conversations (tracking, pins, control endpoints) ----------

async function makeConversationProxy(): Promise<{ proxy: BuyerProxy; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-conv-'))
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: { router: null } as any,
  })
  ;(proxy as any)._getPeers = async () => []
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  return { proxy, dir }
}

test('per-chat pin overrides the default routed model for the antseed alias', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const defaultRoute = `${'aa'.repeat(20)}@default-model`
    const pinnedRoute = `${'bb'.repeat(20)}@pinned-model`
    ;(proxy as any)._defaultRoutedModel = defaultRoute
    const store = (proxy as any)._conversations
    store.touch({ tool: 'codex-exec', sessionKey: 'sess-1' })
    store.setPinnedModel('codex-exec:sess-1', pinnedRoute)

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex_exec', 'session-id': 'sess-1' },
      body: {
        model: 'antseed',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello there' }] }],
      },
    }))

    // Routing itself fails (no peers), but the pin was applied during alias
    // substitution and recorded as the conversation's resolved model.
    const record = store.get('codex-exec:sess-1')
    assert.equal(record?.lastModel, pinnedRoute)

    // A different chat without a pin resolves to the default route.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex_exec', 'session-id': 'sess-2' },
      body: {
        model: 'antseed',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second chat' }] }],
      },
    }))
    const second = store.get('codex-exec:sess-2')
    assert.equal(second?.lastModel, defaultRoute)
    assert.equal(second?.snippet, 'second chat')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chat pin overrides a system-proxy-routed model on intercepted requests', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const proxyRoute = `${'aa'.repeat(20)}@default-model`
    const pinnedRoute = `${'bb'.repeat(20)}@pinned-model`
    const store = (proxy as any)._conversations

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'x-claude-code-session-id': 'cc-1', [SYSTEM_ROUTED_MODEL_HEADER]: '1' },
      body: { model: proxyRoute, messages: [{ role: 'user', content: 'hello there' }] },
    }))
    assert.equal(store.get('claude-code:cc-1')?.pinnedModel, null)
    assert.equal(store.get('claude-code:cc-1')?.lastModel, proxyRoute)

    // The user re-pins the chat from the desktop (float / chats view).
    store.setPinnedModel('claude-code:cc-1', pinnedRoute)

    // Later requests still arrive with the proxy-assigned model; the pin wins.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'x-claude-code-session-id': 'cc-1', [SYSTEM_ROUTED_MODEL_HEADER]: '1' },
      body: { model: proxyRoute, messages: [{ role: 'user', content: 'again' }] },
    }))
    assert.equal(store.get('claude-code:cc-1')?.lastModel, pinnedRoute)

    // Manual pins are the highest-precedence route even when the client sends
    // a different model on a later request.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'x-claude-code-session-id': 'cc-1' },
      body: { model: proxyRoute, messages: [{ role: 'user', content: 'explicit' }] },
    }))
    assert.equal(store.get('claude-code:cc-1')?.lastModel, pinnedRoute)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('count_tokens is answered locally and never reaches a seller', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    let routed = 0
    ;(proxy as any)._getPeers = async () => { routed += 1; return [] }

    const res = await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages/count_tokens',
      headers: { 'x-claude-code-session-id': 'cc-count' },
      body: {
        model: 'claude-sonnet-4-5',
        system: 'You are a CLI assistant. '.repeat(40),
        messages: [{ role: 'user', content: 'how big is this conversation?' }],
      },
    }))

    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as { input_tokens: number }
    assert.ok(body.input_tokens > 50, `expected a token count, got ${JSON.stringify(body)}`)
    assert.equal(routed, 0, 'count_tokens must not route to a peer')
    // It is a probe about a chat, not a turn in one.
    assert.deepEqual((proxy as any)._conversations.list(), [])
    await (proxy as any)._conversations.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a thread the tool opened for itself never becomes a chat', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const store = (proxy as any)._conversations
    const turnMetadata = (threadId: string, threadSource: string): string =>
      JSON.stringify({ thread_id: threadId, request_kind: 'turn', thread_source: threadSource })

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: {
        originator: 'Codex Desktop',
        'thread-id': 'thread-real',
        'x-codex-turn-metadata': turnMetadata('thread-real', 'user'),
      },
      body: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'yo' }] }] },
    }))

    // Codex titles the chat from a system thread of its own, milliseconds later.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: {
        originator: 'Codex Desktop',
        'thread-id': 'thread-title',
        'x-codex-turn-metadata': turnMetadata('thread-title', 'system'),
      },
      body: { input: 'You are a helpful assistant... provide a short title...\n\nUser prompt:\nyo' },
    }))

    assert.deepEqual(store.list().map((c: any) => c.id), ['codex-desktop:thread-real'])
    assert.equal(store.get('codex-desktop:thread-real')?.snippet, 'yo')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('conversation control endpoints list, rename, pin, reject bad pins, delete', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const store = (proxy as any)._conversations
    store.touch({ tool: 'opencode', sessionKey: 'ses_x', snippet: 'refactor the login flow' })

    const list = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/conversations' }))
    assert.equal(list.statusCode, 200)
    const listed = JSON.parse(list.body) as { ok: boolean; conversations: Array<{ id: string; snippet: string }> }
    assert.equal(listed.ok, true)
    assert.equal(listed.conversations.length, 1)
    assert.equal(listed.conversations[0]?.id, 'opencode:ses_x')

    const rename = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', label: 'Login refactor' },
    }))
    assert.equal(rename.statusCode, 200)
    assert.equal(store.get('opencode:ses_x')?.label, 'Login refactor')

    const badPin = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', pinnedModel: 'not-a-route' },
    }))
    assert.equal(badPin.statusCode, 400)

    const goodPin = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', pinnedModel: `${'cc'.repeat(20)}@glm-5` },
    }))
    assert.equal(goodPin.statusCode, 200)
    assert.equal(store.getPinnedModel('opencode', 'ses_x'), `${'cc'.repeat(20)}@glm-5`)

    const clearPin = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', pinnedModel: '' },
    }))
    assert.equal(clearPin.statusCode, 200)
    assert.equal(store.getPinnedModel('opencode', 'ses_x'), null)

    const missing = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'nope:missing', label: 'x' },
    }))
    assert.equal(missing.statusCode, 404)

    const removed = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', delete: true },
    }))
    assert.equal(removed.statusCode, 200)
    assert.equal(store.get('opencode:ses_x'), null)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('subagent requests roll up into the parent conversation', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    ;(proxy as any)._defaultRoutedModel = `${'aa'.repeat(20)}@default-model`
    const store = (proxy as any)._conversations

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'ses_child', 'x-parent-session-id': 'ses_parent' },
      body: { model: 'antseed', messages: [{ role: 'user', content: 'subtask prompt' }] },
    }))

    assert.equal(store.get('opencode:ses_child'), null)
    assert.notEqual(store.get('opencode:ses_parent'), null)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('title request racing ahead of the first turn does not name the chat', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    ;(proxy as any)._defaultRoutedModel = `${'aa'.repeat(20)}@default-model`
    const store = (proxy as any)._conversations

    // OpenCode's ensureTitle request lands first, on the same session.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'ses_race' },
      body: {
        model: 'antseed',
        messages: [
          { role: 'user', content: 'Generate a title for this conversation:\n' },
          { role: 'user', content: 'hi' },
        ],
      },
    }))
    // Title-only housekeeping routes normally but no longer creates the row.
    assert.equal(store.get('opencode:ses_race'), null)

    // A Claude/T3 Code-style pure title request routes normally but does not
    // create a blank conversation row.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'user-agent': 'claude-cli/2.0 (external)', 'x-claude-code-session-id': 'cc_race' },
      body: {
        model: 'antseed',
        messages: [{ role: 'user', content: 'You write concise thread titles for a coding chat.' }],
      },
    }))
    assert.equal(store.get('claude-code:cc_race'), null)

    // The real first turn creates the conversation afterwards.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'user-agent': 'claude-cli/2.0 (external)', 'x-claude-code-session-id': 'cc_race' },
      body: {
        model: 'antseed',
        messages: [{ role: 'user', content: 'fix the login bug' }],
      },
    }))
    assert.equal(store.get('claude-code:cc_race')?.snippet, 'fix the login bug')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeVerifierReach: rejects non-attest paths, sends the attest route as a payment-free control-plane request', async () => {
  const peer = makePeer('a', ['openai'])
  const signal = new AbortController().signal

  const rejectNode = { sendRequest: async () => ({ statusCode: 200, headers: {}, body: new Uint8Array() }) }
  await assert.rejects(
    makeVerifierReach(rejectNode as never, peer, 'antseed-verifier', signal)({ method: 'POST', path: '/v1/chat/completions' }),
    /may only call its attestation route/,
  )

  let opts: Record<string, unknown> | undefined
  const captureNode = {
    sendRequest: async (_peer: unknown, _req: unknown, o: Record<string, unknown>) => {
      opts = o
      return { statusCode: 200, headers: {}, body: new Uint8Array() }
    },
  }
  const resp = await makeVerifierReach(captureNode as never, peer, 'antseed-verifier', signal)(
    { method: 'POST', path: '/_antseed/attest/antseed-verifier', body: new Uint8Array([1]) },
  )
  assert.equal(resp.statusCode, 200)
  assert.equal(opts!.controlPlane, true)
  assert.equal(opts!.signal, signal)
})

test('isModelNotFoundResponse: detects seller and upstream model_not_found rejections', () => {
  const makeResponse = (statusCode: number, body: unknown): SerializedHttpResponse => ({
    requestId: 'r1',
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : new TextEncoder().encode(JSON.stringify(body)),
  })

  // Seller-side pre-payment rejection (seller-request-handler shape).
  assert.equal(isModelNotFoundResponse(makeResponse(400, {
    error: { message: 'Service "x" is not served by this peer.', type: 'invalid_request_error', code: 'model_not_found' },
  })), true)
  // Upstream 404 pass-through with the same code.
  assert.equal(isModelNotFoundResponse(makeResponse(404, {
    error: { message: 'The model does not exist', type: 'invalid_request_error', code: 'model_not_found' },
  })), true)

  // Other 400s must not be misclassified.
  assert.equal(isModelNotFoundResponse(makeResponse(400, {
    error: { message: 'Missing model field', type: 'invalid_request_error', code: 'model_required' },
  })), false)
  assert.equal(isModelNotFoundResponse(makeResponse(400, 'not json')), false)
  assert.equal(isModelNotFoundResponse(makeResponse(200, { ok: true })), false)
  assert.equal(isModelNotFoundResponse(makeResponse(500, {
    error: { code: 'model_not_found' },
  })), false)
})

test('mergeJsonStateFile: merges into existing state and leaves no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-state-'))
  try {
    const stateFile = join(dir, 'buyer.state.json')
    await mergeJsonStateFile(dir, stateFile, { a: 1, pinnedPeerId: 'old' })
    await mergeJsonStateFile(dir, stateFile, { pinnedPeerId: 'new', b: 2 })
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as Record<string, unknown>
    assert.deepEqual(state, { a: 1, pinnedPeerId: 'new', b: 2 })
    const tmpLeftovers = (await readdir(dir)).filter((name) => name.endsWith('.json.tmp'))
    assert.deepEqual(tmpLeftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeJsonStateFile: unlinks the temp file when the rename fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-state-'))
  try {
    // A directory at the state-file path makes rename() fail on every platform
    // with a non-retryable code, exercising the cleanup path.
    const stateFile = join(dir, 'buyer.state.json')
    await mkdir(stateFile)
    await assert.rejects(mergeJsonStateFile(dir, stateFile, { a: 1 }))
    const tmpLeftovers = (await readdir(dir)).filter((name) => name.endsWith('.json.tmp'))
    assert.deepEqual(tmpLeftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweepStaleStateTmpFiles: removes aged temp files, keeps fresh and unrelated ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-state-'))
  try {
    const stale = join(dir, '.buyer.state.11111111-1111-1111-1111-111111111111.json.tmp')
    const fresh = join(dir, '.buyer.state.22222222-2222-2222-2222-222222222222.json.tmp')
    const unrelated = join(dir, 'buyer.state.json')
    await writeFile(stale, '{}')
    await writeFile(fresh, '{}')
    await writeFile(unrelated, '{}')
    const past = new Date(Date.now() - 5 * 60_000)
    await utimes(stale, past, past)

    await sweepStaleStateTmpFiles(dir)

    const remaining = (await readdir(dir)).sort()
    assert.deepEqual(remaining, [
      '.buyer.state.22222222-2222-2222-2222-222222222222.json.tmp',
      'buyer.state.json',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweepStaleStateTmpFiles: tolerates a missing directory', async () => {
  await sweepStaleStateTmpFiles(join(tmpdir(), 'antseed-does-not-exist', randomUUID()))
})
