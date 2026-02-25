import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AntseedNode } from '@antseed/node'
import type {
  PeerInfo,
  RequestStreamResponseMetadata,
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from '@antseed/node'

export interface BuyerProxyConfig {
  port: number
  node: AntseedNode
  /** How long to cache discovered peers before re-querying DHT (ms). Default: 30000 */
  peerCacheTtlMs?: number
}

const DAEMON_STATE_FILE = join(homedir(), '.antseed', 'daemon.state.json')

const DEBUG = () =>
  ['1', 'true', 'yes', 'on'].includes((process.env['ANTSEED_DEBUG'] ?? '').trim().toLowerCase())

function log(...args: unknown[]): void {
  if (DEBUG()) console.log('[proxy]', ...args)
}

type TokenUsageSummary = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  source: 'usage' | 'estimated'
}

type RoutingPricing = {
  provider: string
  model: string | null
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
}

type ResponseTelemetry = {
  usage: TokenUsageSummary
  pricing: RoutingPricing
  estimatedCostUsd: number | null
}

function parseTokenCount(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }
  return Math.floor(parsed)
}

function parseUsageObject(value: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } {
  if (!value || typeof value !== 'object') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  }

  const usage = value as Record<string, unknown>
  const total = parseTokenCount(usage.totalTokens ?? usage.total_tokens ?? usage.total_token_count)
  let input = parseTokenCount(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count
    ?? usage.cache_creation_input_tokens
    ?? usage.cache_read_input_tokens,
  )
  let output = parseTokenCount(
    usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.completion_tokens
    ?? usage.output_token_count
    ?? usage.completion_token_count,
  )

  if (total > 0) {
    if (input === 0 && output === 0) {
      output = total
    } else if (output === 0 && input > 0 && total >= input) {
      output = total - input
    } else if (input === 0 && output > 0 && total >= output) {
      input = total - output
    }
  }

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
  }
}

function estimateTokensFromBytes(inputBytes: number, outputBytes: number): TokenUsageSummary {
  const inputTokens = Math.max(1, Math.round(Math.max(0, inputBytes) / 4))
  const outputTokens = Math.max(1, Math.round(Math.max(0, outputBytes) / 4))
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: 'estimated',
  }
}

function parseSseUsage(body: Uint8Array): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const text = new TextDecoder().decode(body)
  const lines = text.split('\n')
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue

    const payload = trimmed.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }

    const directUsage = parseUsageObject(parsed.usage)
    if (directUsage.totalTokens > 0) {
      inputTokens = Math.max(inputTokens, directUsage.inputTokens)
      outputTokens = Math.max(outputTokens, directUsage.outputTokens)
      totalTokens = Math.max(totalTokens, directUsage.totalTokens)
    }

    const message = parsed.message
    const messageUsage = parseUsageObject(message && typeof message === 'object' ? (message as Record<string, unknown>).usage : undefined)
    if (messageUsage.totalTokens > 0) {
      inputTokens = Math.max(inputTokens, messageUsage.inputTokens)
      outputTokens = Math.max(outputTokens, messageUsage.outputTokens)
      totalTokens = Math.max(totalTokens, messageUsage.totalTokens)
    }
  }

  if (totalTokens <= 0) {
    totalTokens = inputTokens + outputTokens
  }

  return { inputTokens, outputTokens, totalTokens }
}

function parseJsonUsage(body: Uint8Array): { inputTokens: number; outputTokens: number; totalTokens: number } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
    const direct = parseUsageObject(parsed.usage)
    if (direct.totalTokens > 0) {
      return direct
    }

    const message = parsed.message
    if (message && typeof message === 'object') {
      const nested = parseUsageObject((message as Record<string, unknown>).usage)
      if (nested.totalTokens > 0) {
        return nested
      }
    }

    const result = parsed.result
    if (result && typeof result === 'object') {
      const nested = parseUsageObject((result as Record<string, unknown>).usage)
      if (nested.totalTokens > 0) {
        return nested
      }
    }

    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  } catch {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  }
}

function pickProviderForPeer(peer: PeerInfo, request: SerializedHttpRequest): string {
  const explicit = request.headers['x-antseed-provider']?.trim()
  if (explicit && explicit.length > 0) {
    return explicit.toLowerCase()
  }

  if (request.path.startsWith('/v1/messages') && peer.providers.includes('anthropic')) {
    return 'anthropic'
  }

  const first = peer.providers[0]?.trim()
  if (first && first.length > 0) {
    return first.toLowerCase()
  }

  return 'unknown'
}

function extractRequestedModel(request: SerializedHttpRequest): string | null {
  const contentType = (request.headers['content-type'] ?? request.headers['Content-Type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) {
    return null
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>
    const model = parsed.model
    if (typeof model === 'string' && model.trim().length > 0) {
      return model.trim()
    }
    return null
  } catch {
    return null
  }
}

function resolvePeerPricing(peer: PeerInfo, provider: string, model: string | null): { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null } {
  const providerPricing = peer.providerPricing?.[provider]
  if (providerPricing) {
    if (model && providerPricing.models?.[model]) {
      return {
        inputUsdPerMillion: Number.isFinite(providerPricing.models[model]!.inputUsdPerMillion)
          ? providerPricing.models[model]!.inputUsdPerMillion
          : null,
        outputUsdPerMillion: Number.isFinite(providerPricing.models[model]!.outputUsdPerMillion)
          ? providerPricing.models[model]!.outputUsdPerMillion
          : null,
      }
    }
    return {
      inputUsdPerMillion: Number.isFinite(providerPricing.defaults.inputUsdPerMillion)
        ? providerPricing.defaults.inputUsdPerMillion
        : null,
      outputUsdPerMillion: Number.isFinite(providerPricing.defaults.outputUsdPerMillion)
        ? providerPricing.defaults.outputUsdPerMillion
        : null,
    }
  }

  const input = peer.defaultInputUsdPerMillion
  const output = peer.defaultOutputUsdPerMillion
  return {
    inputUsdPerMillion: Number.isFinite(input) ? input! : null,
    outputUsdPerMillion: Number.isFinite(output) ? output! : null,
  }
}

function computeResponseTelemetry(
  request: SerializedHttpRequest,
  responseHeaders: Record<string, string>,
  responseBody: Uint8Array,
  selectedPeer: PeerInfo,
): ResponseTelemetry {
  const provider = pickProviderForPeer(selectedPeer, request)
  const model = extractRequestedModel(request)
  const pricing = resolvePeerPricing(selectedPeer, provider, model)
  const contentType = (responseHeaders['content-type'] ?? '').toLowerCase()

  const usageFromBody = contentType.includes('text/event-stream')
    ? parseSseUsage(responseBody)
    : parseJsonUsage(responseBody)

  let usage: TokenUsageSummary
  if (usageFromBody.totalTokens > 0) {
    usage = {
      inputTokens: usageFromBody.inputTokens,
      outputTokens: usageFromBody.outputTokens,
      totalTokens: usageFromBody.totalTokens,
      source: 'usage',
    }
  } else {
    usage = estimateTokensFromBytes(request.body.length, responseBody.length)
  }

  let estimatedCostUsd: number | null = null
  if (
    pricing.inputUsdPerMillion !== null &&
    pricing.outputUsdPerMillion !== null &&
    Number.isFinite(pricing.inputUsdPerMillion) &&
    Number.isFinite(pricing.outputUsdPerMillion)
  ) {
    estimatedCostUsd =
      (usage.inputTokens * pricing.inputUsdPerMillion + usage.outputTokens * pricing.outputUsdPerMillion) / 1_000_000
  }

  return {
    usage,
    pricing: {
      provider,
      model,
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
    },
    estimatedCostUsd,
  }
}

function attachAntseedTelemetryHeaders(
  upstreamHeaders: Record<string, string>,
  selectedPeer: PeerInfo,
  telemetry: ResponseTelemetry,
  requestId: string,
  latencyMs: number,
): Record<string, string> {
  const headers: Record<string, string> = { ...upstreamHeaders }
  headers['x-antseed-request-id'] = requestId
  headers['x-antseed-latency-ms'] = String(Math.max(0, Math.floor(latencyMs)))
  headers['x-antseed-peer-id'] = selectedPeer.peerId
  if (selectedPeer.publicAddress) {
    headers['x-antseed-peer-address'] = selectedPeer.publicAddress
  }
  if (selectedPeer.providers.length > 0) {
    headers['x-antseed-peer-providers'] = selectedPeer.providers.join(',')
  }
  if (typeof selectedPeer.reputationScore === 'number' && Number.isFinite(selectedPeer.reputationScore)) {
    headers['x-antseed-peer-reputation'] = String(selectedPeer.reputationScore)
  }
  if (typeof selectedPeer.trustScore === 'number' && Number.isFinite(selectedPeer.trustScore)) {
    headers['x-antseed-peer-trust-score'] = String(selectedPeer.trustScore)
  }
  if (typeof selectedPeer.currentLoad === 'number' && Number.isFinite(selectedPeer.currentLoad)) {
    headers['x-antseed-peer-current-load'] = String(selectedPeer.currentLoad)
  }
  if (typeof selectedPeer.maxConcurrency === 'number' && Number.isFinite(selectedPeer.maxConcurrency)) {
    headers['x-antseed-peer-max-concurrency'] = String(selectedPeer.maxConcurrency)
  }
  headers['x-antseed-provider'] = telemetry.pricing.provider
  if (telemetry.pricing.model) {
    headers['x-antseed-model'] = telemetry.pricing.model
  }
  if (telemetry.pricing.inputUsdPerMillion !== null) {
    headers['x-antseed-input-usd-per-million'] = String(telemetry.pricing.inputUsdPerMillion)
  }
  if (telemetry.pricing.outputUsdPerMillion !== null) {
    headers['x-antseed-output-usd-per-million'] = String(telemetry.pricing.outputUsdPerMillion)
  }
  headers['x-antseed-token-source'] = telemetry.usage.source
  headers['x-antseed-input-tokens'] = String(telemetry.usage.inputTokens)
  headers['x-antseed-output-tokens'] = String(telemetry.usage.outputTokens)
  headers['x-antseed-total-tokens'] = String(telemetry.usage.totalTokens)
  if (telemetry.estimatedCostUsd !== null && Number.isFinite(telemetry.estimatedCostUsd)) {
    headers['x-antseed-estimated-cost-usd'] = telemetry.estimatedCostUsd.toFixed(6)
  }
  return headers
}

function attachStreamingAntseedHeaders(
  upstreamHeaders: Record<string, string>,
  selectedPeer: PeerInfo,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...upstreamHeaders }
  headers['x-antseed-request-id'] = requestId
  headers['x-antseed-peer-id'] = selectedPeer.peerId
  if (selectedPeer.publicAddress) {
    headers['x-antseed-peer-address'] = selectedPeer.publicAddress
  }
  if (selectedPeer.providers.length > 0) {
    headers['x-antseed-peer-providers'] = selectedPeer.providers.join(',')
  }
  return headers
}

function requestWantsStreaming(headers: Record<string, string>, body: Uint8Array): boolean {
  const accept = (headers['accept'] ?? headers['Accept'] ?? '').toLowerCase()
  if (accept.includes('text/event-stream')) {
    return true
  }

  const contentType = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json') || body.length === 0) {
    return false
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
    return parsed.stream === true
  } catch {
    return false
  }
}

function extractHostFromAddress(address: string): string {
  const trimmed = address.trim()
  if (trimmed.length === 0) return ''

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end > 1 ? trimmed.slice(1, end).toLowerCase() : ''
  }

  const idx = trimmed.lastIndexOf(':')
  if (idx > 0) {
    return trimmed.slice(0, idx).toLowerCase()
  }
  return trimmed.toLowerCase()
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function isLoopbackPeer(peer: PeerInfo): boolean {
  if (!peer.publicAddress) {
    return false
  }
  const host = extractHostFromAddress(peer.publicAddress)
  return isLoopbackHost(host)
}

/**
 * Local HTTP proxy that forwards requests to P2P sellers.
 *
 * Tools like Claude CLI set ANTHROPIC_BASE_URL=http://localhost:8377
 * and the proxy transparently routes their API calls through the
 * Antseed P2P network.
 */
export class BuyerProxy {
  private readonly _server: Server
  private readonly _node: AntseedNode
  private readonly _port: number
  private readonly _peerCacheTtlMs: number

  private _cachedPeers: PeerInfo[] = []
  private _cacheTimestamp = 0

  constructor(config: BuyerProxyConfig) {
    this._node = config.node
    this._port = config.port
    this._peerCacheTtlMs = config.peerCacheTtlMs ?? 30_000
    this._server = createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        log('Unhandled error:', err)
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' })
        }
        res.end(`Proxy error: ${err instanceof Error ? err.message : String(err)}`)
      })
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(this._port, '127.0.0.1', () => {
        this._server.removeListener('error', reject)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this._server.close(() => resolve())
    })
  }

  private async _readLocalSeederFallback(): Promise<PeerInfo | null> {
    try {
      const raw = await readFile(DAEMON_STATE_FILE, 'utf-8')
      const parsed = JSON.parse(raw) as {
        state?: unknown
        pid?: unknown
        peerId?: unknown
        signalingPort?: unknown
        provider?: unknown
        defaultInputUsdPerMillion?: unknown
        defaultOutputUsdPerMillion?: unknown
        providerPricing?: unknown
      }

      if (parsed.state !== 'seeding') return null
      if (typeof parsed.peerId !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.peerId)) return null

      const signalingPort = Number(parsed.signalingPort)
      if (!Number.isFinite(signalingPort) || signalingPort <= 0 || signalingPort > 65535) return null

      const pid = Number(parsed.pid)
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(Math.floor(pid), 0)
        } catch {
          return null
        }
      }

      const providers = typeof parsed.provider === 'string' && parsed.provider.trim().length > 0
        ? [parsed.provider.trim()]
        : []
      const defaultInputUsdPerMillion = Number(parsed.defaultInputUsdPerMillion)
      const defaultOutputUsdPerMillion = Number(parsed.defaultOutputUsdPerMillion)
      const providerPricing = parsed.providerPricing && typeof parsed.providerPricing === 'object'
        ? (parsed.providerPricing as PeerInfo['providerPricing'])
        : undefined

      const peerId = parsed.peerId.toLowerCase()

      return {
        peerId: peerId as PeerInfo['peerId'],
        lastSeen: Date.now(),
        publicAddress: `127.0.0.1:${Math.floor(signalingPort)}`,
        providers,
        defaultInputUsdPerMillion: Number.isFinite(defaultInputUsdPerMillion) ? defaultInputUsdPerMillion : 0,
        defaultOutputUsdPerMillion: Number.isFinite(defaultOutputUsdPerMillion) ? defaultOutputUsdPerMillion : 0,
        ...(providerPricing ? { providerPricing } : {}),
      }
    } catch {
      return null
    }
  }

  private async _getPeers(): Promise<PeerInfo[]> {
    const now = Date.now()
    if (this._cachedPeers.length > 0 && now - this._cacheTimestamp < this._peerCacheTtlMs) {
      return this._cachedPeers
    }

    const localSeeder = await this._readLocalSeederFallback()
    if (localSeeder) {
      this._cachedPeers = [localSeeder]
      this._cacheTimestamp = now
      log(`Using local seeder ${localSeeder.peerId.slice(0, 12)}... @ ${localSeeder.publicAddress} (skipping DHT lookup)`)
      return this._cachedPeers
    }

    log('Discovering peers via DHT...')
    const peers = await this._node.discoverPeers()

    if (peers.length > 0) {
      this._cachedPeers = peers
      this._cacheTimestamp = now
      log(`Found ${peers.length} peer(s)`)
      return peers
    }

    // DHT returned nothing — fall back to stale cached peers if available.
    // The peer may still be reachable even if the DHT announcement expired.
    if (this._cachedPeers.length > 0) {
      log(`DHT returned 0 peers, reusing ${this._cachedPeers.length} stale cached peer(s)`)
      return this._cachedPeers
    }

    return peers
  }

  private _formatPeerSelectionDiagnostics(peers: PeerInfo[]): string {
    if (peers.length === 0) {
      return 'No peers discovered.'
    }

    const summarize = (peer: PeerInfo): string => {
      const providers = peer.providers
        .map((provider) => provider.trim())
        .filter((provider) => provider.length > 0)
      const trust = Number.isFinite(peer.trustScore) ? String(peer.trustScore) : 'n/a'
      const rep = Number.isFinite(peer.reputationScore) ? String(peer.reputationScore) : 'n/a'
      const onChain = Number.isFinite(peer.onChainReputation) ? String(peer.onChainReputation) : 'n/a'
      const input = Number.isFinite(peer.defaultInputUsdPerMillion) ? String(peer.defaultInputUsdPerMillion) : 'n/a'
      const output = Number.isFinite(peer.defaultOutputUsdPerMillion) ? String(peer.defaultOutputUsdPerMillion) : 'n/a'

      return `${peer.peerId.slice(0, 8)} providers=[${providers.join(',') || 'none'}] trust=${trust} rep=${rep} onchain=${onChain} in=${input} out=${output}`
    }

    const samples = peers.slice(0, 5).map((peer) => summarize(peer)).join(' | ')
    const suffix = peers.length > 5 ? ` (+${peers.length - 5} more)` : ''
    return `Discovered ${peers.length} peer(s): ${samples}${suffix}`
  }

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'

    log(`${method} ${path}`)

    // Collect request body
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks)

    // Build serialized request
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ')
      }
    }
    // Remove host header (points to localhost, not the seller)
    delete headers['host']

    const serializedReq: SerializedHttpRequest = {
      requestId: randomUUID(),
      method,
      path,
      headers,
      body: new Uint8Array(body),
    }

    // Discover peers
    const peers = await this._getPeers()
    if (peers.length === 0) {
      log('No sellers available')
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('No sellers available on the network. Is a seeder running?')
      return
    }

    // Use router to select peer
    const router = this._node.router
    const localPeers = peers.filter((peer) => isLoopbackPeer(peer))
    let selectedPeer: PeerInfo | null = null

    if (localPeers.length > 0) {
      selectedPeer = router
        ? router.selectPeer(serializedReq, localPeers)
        : localPeers[0] ?? null
      if (selectedPeer) {
        log(`Preferring local peer ${selectedPeer.peerId.slice(0, 12)}... @ ${selectedPeer.publicAddress ?? 'unknown'}`)
      }
    }

    if (!selectedPeer) {
      selectedPeer = router
        ? router.selectPeer(serializedReq, peers)
        : peers[0] ?? null
    }

    if (!selectedPeer) {
      const diagnostics = this._formatPeerSelectionDiagnostics(peers)
      log('Router could not select a peer.', diagnostics)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`Router could not select a suitable peer. ${diagnostics}`)
      return
    }

    log(`Routing to peer ${selectedPeer.peerId.slice(0, 12)}...`)

    // Forward through P2P
    const wantsStreaming = requestWantsStreaming(headers, serializedReq.body)
    const startTime = Date.now()
    try {
      if (wantsStreaming) {
        let streamed = false
        const response = await this._node.sendRequestStream(selectedPeer, serializedReq, {
          onResponseStart: (startResponse: SerializedHttpResponse, metadata: RequestStreamResponseMetadata) => {
            if (!metadata.streaming) return
            streamed = true
            const streamingHeaders = attachStreamingAntseedHeaders(
              startResponse.headers,
              selectedPeer,
              serializedReq.requestId,
            )
            res.writeHead(startResponse.statusCode, streamingHeaders)
            if (startResponse.body.length > 0) {
              res.write(Buffer.from(startResponse.body))
            }
          },
          onResponseChunk: (chunk: SerializedHttpResponseChunk) => {
            if (!streamed) return
            if (chunk.data.length > 0) {
              res.write(Buffer.from(chunk.data))
            }
          },
        })

        const latencyMs = Date.now() - startTime
        log(`Response: ${response.statusCode} (${latencyMs}ms, ${response.body.length} bytes)`)

        const telemetry = computeResponseTelemetry(serializedReq, response.headers, response.body, selectedPeer)
        if (router) {
          router.onResult(selectedPeer, {
            success: response.statusCode < 500,
            latencyMs,
            tokens: telemetry.usage.totalTokens,
          })
        }

        if (streamed) {
          if (!res.writableEnded) {
            res.end()
          }
        } else {
          const responseHeaders = attachAntseedTelemetryHeaders(
            response.headers,
            selectedPeer,
            telemetry,
            serializedReq.requestId,
            latencyMs,
          )
          res.writeHead(response.statusCode, responseHeaders)
          res.end(Buffer.from(response.body))
        }
      } else {
        const response = await this._node.sendRequest(selectedPeer, serializedReq)
        const latencyMs = Date.now() - startTime

        log(`Response: ${response.statusCode} (${latencyMs}ms, ${response.body.length} bytes)`)

        const telemetry = computeResponseTelemetry(serializedReq, response.headers, response.body, selectedPeer)
        const responseHeaders = attachAntseedTelemetryHeaders(
          response.headers,
          selectedPeer,
          telemetry,
          serializedReq.requestId,
          latencyMs,
        )

        // Report result to router for learning
        if (router) {
          router.onResult(selectedPeer, {
            success: response.statusCode < 500,
            latencyMs,
            tokens: telemetry.usage.totalTokens,
          })
        }

        // Forward response headers and body to the HTTP client
        res.writeHead(response.statusCode, responseHeaders)
        res.end(Buffer.from(response.body))
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime
      const message = err instanceof Error ? err.message : String(err)
      log(`Request failed after ${latencyMs}ms: ${message}`)

      if (router) {
        router.onResult(selectedPeer, {
          success: false,
          latencyMs,
          tokens: 0,
        })
      }

      // Invalidate peer cache on connection errors so next request re-discovers
      this._cachedPeers = []
      this._cacheTimestamp = 0

      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`P2P request failed: ${message}`)
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  }
}
