import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AntseedNode,
  PeerInfo,
  RequestStreamResponseMetadata,
  Router,
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from '@antseed/node'
import {
  createOpenAIChatToAnthropicStreamingAdapter,
  createOpenAIChatToResponsesStreamingAdapter,
  createOpenAIResponsesToChatStreamingAdapter,
  detectRequestServiceApiProtocol,
  type ServiceApiProtocol,
  type StreamingResponseAdapter,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatRequestToOpenAIResponses,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIChatResponseToOpenAIResponses,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIResponsesResponseToOpenAIChat,
} from './service-api-adapter.js'
import {
  DEBUG,
  log,
  extractRequestedService,
  summarizeRequestShape,
  summarizeErrorResponse,
  requestWantsStreaming,
  rewriteServiceInBody,
  isConnectionChurnError,
  isConnectionHealthy,
} from './request-utils.js'
import {
  getExplicitProviderOverride,
  getExplicitPeerIdOverride,
  resolvePeerRoutePlan,
  selectCandidatePeersForRouting,
  type CandidatePeerRouteSelection,
  type PeerProtocolRoutePlan,
} from './routing.js'
import {
  computeResponseTelemetry,
  attachAntseedTelemetryHeaders,
  attachStreamingAntseedHeaders,
} from './telemetry.js'

// Re-export for backward compatibility (used by tests and other consumers)
export { selectCandidatePeersForRouting, type CandidatePeerRouteSelection } from './routing.js'
export { rewriteServiceInBody } from './request-utils.js'

export interface BuyerProxyConfig {
  port: number
  node: AntseedNode
  /** Data directory used to persist buyer.state.json (discovered peers, session overrides). */
  dataDir: string
  /** How often to refresh the peer list from DHT in the background (ms). Default: 300000 (5 min) */
  backgroundRefreshIntervalMs?: number
  /**
   * Max age for the in-memory peer cache before it is treated as stale (ms).
   * Stale caches can still be used for routing while background refresh repopulates.
   * Default: 360000 (6 min) — chosen to exceed `backgroundRefreshIntervalMs`
   * (5 min) so a healthy proxy never naturally reaches the "stale" threshold.
   */
  peerCacheTtlMs?: number
  /**
   * Pin all requests to a specific peer ID for this session.
   * The router is bypassed; the named peer is used directly if it is available
   * and protocol-compatible. A 502 is returned if the peer cannot be reached.
   */
  pinnedPeerId?: string
  /**
   * Pin all requests to a specific service ID for this session.
   * Overrides the service field in the request body before routing and forwarding.
   * Can be updated at runtime via `antseed buyer connection set --service`.
   */
  pinnedService?: string
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])
/**
 * Max age for carrying forward peers not seen in the latest DHT scan.
 * Intentionally longer than `peer-lookup.ts` `maxAnnouncementAgeMs` (30 min) so
 * a peer that misses one reannounce cycle doesn't hit both cliffs at once.
 * For peers we have recently reached over the transport, we trust local
 * liveness (`lastReachedAt`) even if the DHT record is older.
 */
const CARRY_FORWARD_TTL_MS = 2 * 60 * 60_000

type TransformResult = { request: SerializedHttpRequest; streamRequested: boolean; requestedModel: string | null }
type AdaptResponseMeta = { streamRequested: boolean; fallbackModel: string | null }

type ProtocolTransformStrategy = {
  transformRequest: (req: SerializedHttpRequest) => TransformResult | null
  adaptResponse: (res: SerializedHttpResponse, meta: AdaptResponseMeta) => SerializedHttpResponse
  createStreamAdapter: (opts: { fallbackModel: string | null }) => StreamingResponseAdapter
}

function adaptOpenAICompatibleErrorResponse(
  response: SerializedHttpResponse,
  requestProtocol: ServiceApiProtocol | null,
): SerializedHttpResponse {
  if (response.statusCode !== 402) {
    return response;
  }
  if (requestProtocol !== 'openai-responses' && requestProtocol !== 'openai-chat-completions') {
    return response;
  }

  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as Record<string, unknown>
  } catch {
    return response
  }

  if (!parsed || parsed.error !== 'payment_required') {
    return response
  }

  // Wrap into standard OpenAI error format { error: { type, message, ... } }.
  // Exclude the flat 'error' string field to avoid polluting the nested error object.
  const { error: _errorField, ...rest } = parsed
  const wrappedError = {
    error: {
      ...rest,
      type: 'payment_required',
      message: JSON.stringify(parsed),
    },
  }

  return {
    ...response,
    headers: {
      ...response.headers,
      'content-type': 'application/json',
    },
    body: Buffer.from(JSON.stringify(wrappedError)),
  }
}

/**
 * Inject the buyer-known peerId into a 402 payment_required JSON body.
 * The seller doesn't include its own peerId (and shouldn't — self-reported
 * identity is untrusted). The buyer proxy knows which peer it connected to,
 * so it stamps the peerId into the body before forwarding to the client.
 */
function inject402PeerId(
  response: SerializedHttpResponse,
  peerId: string,
): SerializedHttpResponse {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as Record<string, unknown>
  } catch {
    return response
  }
  if (!parsed) return response

  // Handle both flat { error: 'payment_required', ... } and
  // wrapped { error: { type: 'payment_required', ... } } formats.
  if (parsed.error === 'payment_required') {
    parsed.peerId = peerId
  } else if (
    typeof parsed.error === 'object' &&
    parsed.error !== null &&
    (parsed.error as Record<string, unknown>).type === 'payment_required'
  ) {
    (parsed.error as Record<string, unknown>).peerId = peerId
  } else {
    return response
  }

  return {
    ...response,
    body: Buffer.from(JSON.stringify(parsed)),
  }
}

const PROTOCOL_TRANSFORMS: Record<string, ProtocolTransformStrategy> = {
  'anthropic-messages→openai-chat-completions': {
    transformRequest: transformAnthropicMessagesRequestToOpenAIChat,
    adaptResponse: (res, meta) => transformOpenAIChatResponseToAnthropicMessage(res, meta),
    createStreamAdapter: createOpenAIChatToAnthropicStreamingAdapter,
  },
  'openai-responses→openai-chat-completions': {
    transformRequest: transformOpenAIResponsesRequestToOpenAIChat,
    adaptResponse: (res, meta) => transformOpenAIChatResponseToOpenAIResponses(res, meta),
    createStreamAdapter: createOpenAIChatToResponsesStreamingAdapter,
  },
  'openai-chat-completions→openai-responses': {
    transformRequest: transformOpenAIChatRequestToOpenAIResponses,
    adaptResponse: (res, meta) => transformOpenAIResponsesResponseToOpenAIChat(res, meta),
    createStreamAdapter: createOpenAIResponsesToChatStreamingAdapter,
  },
}

/**
 * Parses a buyer.state.json blob into PeerInfo[], dropping entries with
 * missing/invalid peerIds, non-array providers, or lastSeen timestamps older
 * than the carry-forward window. Exported for unit testing.
 */
export function parsePersistedPeers(
  parsed: unknown,
  nowMs: number = Date.now(),
  maxAgeMs: number = CARRY_FORWARD_TTL_MS,
): PeerInfo[] {
  if (!parsed || typeof parsed !== 'object') return []
  const discovered = (parsed as { discoveredPeers?: unknown }).discoveredPeers
  if (!Array.isArray(discovered)) return []

  const peers: PeerInfo[] = []
  for (const raw of discovered) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const peerId = typeof entry.peerId === 'string' ? entry.peerId.toLowerCase() : ''
    if (!/^[0-9a-f]{40}$/.test(peerId)) continue
    if (!Array.isArray(entry.providers)) continue
    const providers = entry.providers.filter((p): p is string => typeof p === 'string')
    const lastSeen = typeof entry.lastSeen === 'number' && Number.isFinite(entry.lastSeen)
      ? entry.lastSeen
      : 0
    const lastReachedAt = typeof entry.lastReachedAt === 'number' && Number.isFinite(entry.lastReachedAt)
      ? entry.lastReachedAt
      : 0
    // Keep if either DHT observation or successful transport contact is within window.
    const freshnessAnchor = Math.max(lastSeen, lastReachedAt)
    if (freshnessAnchor <= 0 || nowMs - freshnessAnchor >= maxAgeMs) continue

    const peer: PeerInfo = {
      peerId: peerId as PeerInfo['peerId'],
      lastSeen,
      providers,
    }
    if (lastReachedAt > 0) peer.lastReachedAt = lastReachedAt
    if (typeof entry.displayName === 'string') peer.displayName = entry.displayName
    if (typeof entry.publicAddress === 'string') peer.publicAddress = entry.publicAddress
    if (entry.providerPricing && typeof entry.providerPricing === 'object') {
      peer.providerPricing = entry.providerPricing as PeerInfo['providerPricing']
    }
    if (entry.providerServiceCategories && typeof entry.providerServiceCategories === 'object') {
      peer.providerServiceCategories = entry.providerServiceCategories as PeerInfo['providerServiceCategories']
    }
    if (entry.providerServiceApiProtocols && typeof entry.providerServiceApiProtocols === 'object') {
      peer.providerServiceApiProtocols = entry.providerServiceApiProtocols as PeerInfo['providerServiceApiProtocols']
    }
    if (typeof entry.defaultInputUsdPerMillion === 'number') {
      peer.defaultInputUsdPerMillion = entry.defaultInputUsdPerMillion
    }
    if (typeof entry.defaultOutputUsdPerMillion === 'number') {
      peer.defaultOutputUsdPerMillion = entry.defaultOutputUsdPerMillion
    }
    if (typeof entry.maxConcurrency === 'number') {
      peer.maxConcurrency = entry.maxConcurrency
    }
    if (typeof entry.onChainChannelCount === 'number' && Number.isFinite(entry.onChainChannelCount)) {
      peer.onChainChannelCount = entry.onChainChannelCount
    }
    if (typeof entry.onChainGhostCount === 'number' && Number.isFinite(entry.onChainGhostCount)) {
      peer.onChainGhostCount = entry.onChainGhostCount
    }
    if (typeof entry.onChainTotalVolumeUsdcMicros === 'number' && Number.isFinite(entry.onChainTotalVolumeUsdcMicros)) {
      peer.onChainTotalVolumeUsdcMicros = entry.onChainTotalVolumeUsdcMicros
    }
    if (typeof entry.onChainLastSettledAtSec === 'number' && Number.isFinite(entry.onChainLastSettledAtSec)) {
      peer.onChainLastSettledAtSec = entry.onChainLastSettledAtSec
    }
    if (typeof entry.onChainStatsFetchedAt === 'number' && Number.isFinite(entry.onChainStatsFetchedAt)) {
      peer.onChainStatsFetchedAt = entry.onChainStatsFetchedAt
    }
    peers.push(peer)
  }
  return peers
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
  private readonly _bgRefreshIntervalMs: number
  private readonly _peerCacheTtlMs: number
  private readonly _stateDir: string
  private readonly _stateFile: string
  private _pinnedPeer: string | null
  private _pinnedService: string | null
  private _stateFileWatcher: FSWatcher | null = null
  private _stateWatchDebounce: ReturnType<typeof setTimeout> | null = null

  private _stateWriteChain: Promise<void> = Promise.resolve()

  private _cachedPeers: PeerInfo[] = []
  private _cacheLastUpdatedAtMs = 0
  private _cacheMutationEpoch = 0
  private _peerRefreshPromise: Promise<PeerInfo[]> | null = null
  private _lastStaleCacheLogAtMs = 0
  private _bgRefreshHandle: ReturnType<typeof setInterval> | null = null

  constructor(config: BuyerProxyConfig) {
    this._node = config.node
    this._port = config.port
    this._bgRefreshIntervalMs = config.backgroundRefreshIntervalMs ?? 5 * 60_000
    this._peerCacheTtlMs = Math.max(0, config.peerCacheTtlMs ?? 6 * 60_000)
    this._stateDir = config.dataDir
    this._stateFile = join(config.dataDir, 'buyer.state.json')
    this._pinnedPeer = config.pinnedPeerId?.toLowerCase() ?? null
    this._pinnedService = config.pinnedService?.trim() ?? null
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
    // Hydrate the in-memory peer cache from the persisted state file BEFORE
    // the server starts accepting requests. This lets the first request after
    // startup route from the warm cache without blocking on DHT discovery.
    // The background refresh still runs to pick up fresh peers and IP changes.
    await this._hydratePeersFromStateFile()
    await new Promise<void>((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(this._port, '127.0.0.1', () => {
        this._server.removeListener('error', reject)
        resolve()
      })
    })
    this._startBackgroundRefresh()
    // Trigger initial peer discovery immediately so the desktop can show
    // services without waiting for the first request or 5-minute interval.
    void this._refreshPeersNow().catch(() => {})
    await this._writeStateFile('connected')
    this._watchStateFile()
  }

  private async _hydratePeersFromStateFile(): Promise<void> {
    try {
      const raw = await readFile(this._stateFile, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const peers = parsePersistedPeers(parsed)
      if (peers.length === 0) {
        return
      }
      this._cachedPeers = peers
      // Preserve the original discovery timestamp so cacheAgeMs reflects how
      // long ago the persisted data was actually written, not startup time.
      const peersUpdatedAt = (parsed as { peersUpdatedAt?: unknown }).peersUpdatedAt
      this._cacheLastUpdatedAtMs = typeof peersUpdatedAt === 'number' && Number.isFinite(peersUpdatedAt)
        ? peersUpdatedAt
        : Date.now()
      this._cacheMutationEpoch += 1
      log(`Hydrated ${peers.length} peer(s) from ${this._stateFile}`)
    } catch {
      // File missing, unreadable, or malformed — non-fatal. The background
      // refresh will populate the cache shortly.
    }
  }

  async stop(): Promise<void> {
    if (this._stateWatchDebounce) {
      clearTimeout(this._stateWatchDebounce)
      this._stateWatchDebounce = null
    }
    if (this._stateFileWatcher) {
      this._stateFileWatcher.close()
      this._stateFileWatcher = null
    }
    if (this._bgRefreshHandle) {
      clearInterval(this._bgRefreshHandle)
      this._bgRefreshHandle = null
    }
    await this._writeStateFile('stopped')
    return new Promise((resolve) => {
      this._server.close(() => resolve())
    })
  }

  private _watchStateFile(): void {
    try {
      this._stateFileWatcher = watch(this._stateFile, { persistent: false }, () => {
        if (this._stateWatchDebounce) clearTimeout(this._stateWatchDebounce)
        this._stateWatchDebounce = setTimeout(() => {
          this._stateWatchDebounce = null
          void this._reloadSessionOverrides().catch(() => {})
        }, 50)
      })
      this._stateFileWatcher.on('error', () => {
        // watcher error is non-fatal
      })
    } catch {
      // watcher setup failed; non-fatal
    }
  }

  private async _reloadSessionOverrides(): Promise<void> {
    try {
      const raw = await readFile(this._stateFile, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const pinnedService = typeof parsed.pinnedService === 'string' && parsed.pinnedService.trim().length > 0
        ? parsed.pinnedService.trim()
        : null
      const pinnedPeer = typeof parsed.pinnedPeerId === 'string' && parsed.pinnedPeerId.trim().length > 0
        ? parsed.pinnedPeerId.trim().toLowerCase()
        : null
      this._pinnedService = pinnedService
      this._pinnedPeer = pinnedPeer
      log(`Session overrides reloaded: service=${pinnedService ?? 'none'} peer=${pinnedPeer ?? 'none'}`)
    } catch {
      // state file unreadable; keep current values
    }
  }

  /** Serialised read-modify-write to buyer.state.json. Returns the queued write promise. */
  private _mergeStateFile(patch: Record<string, unknown>): Promise<void> {
    this._stateWriteChain = this._stateWriteChain.then(async () => {
      try {
        await mkdir(this._stateDir, { recursive: true })
        let existing: Record<string, unknown> = {}
        try {
          const raw = await readFile(this._stateFile, 'utf-8')
          existing = JSON.parse(raw) as Record<string, unknown>
        } catch {
          // file doesn't exist yet
        }
        const data = { ...existing, ...patch }
        const tmp = join(this._stateDir, `.buyer.state.${randomUUID()}.json.tmp`)
        await writeFile(tmp, JSON.stringify(data, null, 2))
        await rename(tmp, this._stateFile)
      } catch {
        // non-fatal
      }
    }).catch(() => {})
    return this._stateWriteChain
  }

  private async _writeStateFile(state: 'connected' | 'stopped'): Promise<void> {
    // When stopping, preserve whatever pinnedService/pinnedPeerId is already
    // in the file — the debounce may have been cancelled before
    // _reloadSessionOverrides could commit the latest CLI-written values.
    const sessionOverrides = state === 'connected'
      ? { pinnedService: this._pinnedService, pinnedPeerId: this._pinnedPeer }
      : {}
    await this._mergeStateFile({
      state,
      pid: process.pid,
      port: this._port,
      ...sessionOverrides,
    })
  }

  private _startBackgroundRefresh(): void {
    this._bgRefreshHandle = setInterval(() => {
      void this._refreshPeersNow().catch(() => {
        // background refresh failure is non-fatal
      })
    }, this._bgRefreshIntervalMs)
  }

  private _replacePeers(incoming: PeerInfo[]): void {
    const incomingById = new Map(incoming.map((p) => [p.peerId, p]))
    const prevById = new Map(this._cachedPeers.map((p) => [p.peerId, p]))
    const now = Date.now()

    // For peers re-observed in this scan, preserve `lastReachedAt` from the
    // previous cache entry — the DHT announcement doesn't carry that field,
    // and losing it on each refresh would defeat the carry-forward tracking.
    const merged: PeerInfo[] = incoming.map((peer) => {
      const prev = prevById.get(peer.peerId)
      if (prev?.lastReachedAt && (!peer.lastReachedAt || prev.lastReachedAt > peer.lastReachedAt)) {
        return { ...peer, lastReachedAt: prev.lastReachedAt }
      }
      return peer
    })

    // Carry forward previously known peers that are missing from this scan.
    // A missed DHT scan doesn't mean the peer is unavailable — it just wasn't
    // discovered this time. Use the fresher of `lastSeen` and `lastReachedAt`
    // as the liveness anchor: a recently-contacted peer survives even if its
    // DHT record has aged out.
    for (const prev of this._cachedPeers) {
      if (incomingById.has(prev.peerId)) continue
      const freshnessAnchor = Math.max(prev.lastSeen, prev.lastReachedAt ?? 0)
      if (freshnessAnchor > 0 && now - freshnessAnchor < CARRY_FORWARD_TTL_MS) {
        merged.push({ ...prev })
      }
    }

    this._cachedPeers = merged
    this._cacheLastUpdatedAtMs = Date.now()
    this._cacheMutationEpoch += 1
    this._persistPeersToState()
  }

  private _persistPeersToState(): void {
    // Write discovered peers to buyer.state.json so the dashboard can read them
    // without running its own DHT node.
    const peers = this._cachedPeers.map((p) => {
      // Extract service names from providerPricing entries.
      const services: string[] = []
      if (p.providerPricing) {
        for (const entry of Object.values(p.providerPricing)) {
          if (entry.services) {
            services.push(...Object.keys(entry.services))
          }
        }
      }
      return {
        peerId: p.peerId,
        displayName: p.displayName ?? null,
        publicAddress: p.publicAddress ?? null,
        providers: p.providers,
        services,
        providerPricing: p.providerPricing ?? null,
        providerServiceCategories: p.providerServiceCategories ?? null,
        providerServiceApiProtocols: p.providerServiceApiProtocols ?? null,
        defaultInputUsdPerMillion: p.defaultInputUsdPerMillion ?? 0,
        defaultOutputUsdPerMillion: p.defaultOutputUsdPerMillion ?? 0,
        maxConcurrency: p.maxConcurrency ?? 0,
        currentLoad: p.currentLoad ?? null,
        // On-chain stats read authoritatively by the buyer from AntseedChannels.
        // Persisted so `antseed network browse` can render richer UI without a
        // fresh DHT + RPC round-trip.
        onChainChannelCount: p.onChainChannelCount ?? null,
        onChainGhostCount: p.onChainGhostCount ?? null,
        onChainTotalVolumeUsdcMicros: p.onChainTotalVolumeUsdcMicros ?? null,
        onChainLastSettledAtSec: p.onChainLastSettledAtSec ?? null,
        onChainStatsFetchedAt: p.onChainStatsFetchedAt ?? null,
        lastSeen: p.lastSeen,
        lastReachedAt: p.lastReachedAt ?? null,
      }
    })
    const onChainRefreshedAt = this._cachedPeers
      .map((p) => p.onChainStatsFetchedAt ?? 0)
      .reduce((max, v) => (v > max ? v : max), 0)
    this._mergeStateFile({
      discoveredPeers: peers,
      peersUpdatedAt: Date.now(),
      ...(onChainRefreshedAt > 0 ? { onChainStatsRefreshedAt: onChainRefreshedAt } : {}),
    })
  }

  private _evictPeer(peerId: string): void {
    const before = this._cachedPeers.length
    this._cachedPeers = this._cachedPeers.filter((p) => p.peerId !== peerId)
    if (this._cachedPeers.length < before) {
      this._cacheLastUpdatedAtMs = Date.now()
      this._cacheMutationEpoch += 1
      this._persistPeersToState()
      log(`Evicted failing peer ${peerId.slice(0, 12)}... from cache (${this._cachedPeers.length} remaining)`)
    }
  }

  /**
   * Stamp `lastReachedAt` on a peer after a successful request so the
   * carry-forward heuristic can trust local transport liveness even when the
   * DHT record grows stale. Persisted so the signal survives restarts.
   */
  private _rememberSuccessfulPeer(peerId: string): void {
    const cached = this._cachedPeers.find((p) => p.peerId === peerId)
    if (cached) {
      cached.lastReachedAt = Date.now()
      this._persistPeersToState()
    }
  }

  private async _discoverPeersFromNetwork(): Promise<PeerInfo[]> {
    log('Discovering peers via DHT...')
    const peers = await this._node.discoverPeers()
    if (peers.length > 0) {
      log(`Found ${peers.length} peer(s)`)
    }
    return peers
  }

  private async _refreshPeersNow(): Promise<PeerInfo[]> {
    if (this._peerRefreshPromise) {
      return this._peerRefreshPromise
    }

    const previousCachedPeers = [...this._cachedPeers]
    const mutationEpochAtStart = this._cacheMutationEpoch
    this._peerRefreshPromise = (async () => {
      const peers = await this._discoverPeersFromNetwork()
      if (peers.length > 0) {
        this._replacePeers(peers)
        return peers
      }

      const fallbackPeers = previousCachedPeers.length > 0 && this._cacheMutationEpoch === mutationEpochAtStart
        ? [...previousCachedPeers]
        : []
      if (fallbackPeers.length > 0) {
        // Preserve stale cache as fallback when discovery transiently fails.
        log('Discovery returned 0 peers; preserving most-recent cached peers as fallback.')
        this._replacePeers(fallbackPeers)
        return fallbackPeers
      }
      return peers
    })().finally(() => {
      this._peerRefreshPromise = null
    })

    return this._peerRefreshPromise
  }

  private async _getPeers(options?: { forceRefresh?: boolean }): Promise<PeerInfo[]> {
    const forceRefresh = options?.forceRefresh === true
    const cacheAgeMs = Date.now() - this._cacheLastUpdatedAtMs
    const cacheFresh = this._cacheLastUpdatedAtMs > 0 && cacheAgeMs <= this._peerCacheTtlMs

    if (forceRefresh) {
      log('Forcing peer refresh before routing.')
      return this._refreshPeersNow()
    }

    if (this._cachedPeers.length > 0) {
      if (cacheFresh) {
        return this._cachedPeers
      }

      const now = Date.now()
      if (now - this._lastStaleCacheLogAtMs >= 10_000) {
        this._lastStaleCacheLogAtMs = now
        log(`Peer cache stale (${cacheAgeMs}ms old); routing from cached peers.`)
      }
      return this._cachedPeers
    }

    // No cached peers yet — block on initial discovery.
    return this._refreshPeersNow()
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
      const onChain = Number.isFinite(peer.onChainChannelCount) ? String(peer.onChainChannelCount) : 'n/a'
      const input = Number.isFinite(peer.defaultInputUsdPerMillion) ? String(peer.defaultInputUsdPerMillion) : 'n/a'
      const output = Number.isFinite(peer.defaultOutputUsdPerMillion) ? String(peer.defaultOutputUsdPerMillion) : 'n/a'

      return `${peer.peerId.slice(0, 8)} providers=[${providers.join(',') || 'none'}] trust=${trust} rep=${rep} onchain=${onChain} in=${input} out=${output}`
    }

    const samples = peers.slice(0, 5).map((peer) => summarize(peer)).join(' | ')
    const suffix = peers.length > 5 ? ` (+${peers.length - 5} more)` : ''
    return `Discovered ${peers.length} peer(s): ${samples}${suffix}`
  }

  private async _handleControlPlane(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    const origin = req.headers.origin ?? '';
    const isLocal = origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost') || origin === 'file://';
    if (isLocal) res.setHeader('Access-Control-Allow-Origin', origin);
    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204)
      res.end()
      return
    }
    if (path === '/_antseed/peers' && method === 'GET') {
      const peers = await this._getPeers()
      const payload = peers.map((p) => ({
        peerId: p.peerId,
        displayName: p.displayName,
        publicAddress: p.publicAddress,
        providers: p.providers,
        providerPricing: p.providerPricing,
        providerServiceCategories: p.providerServiceCategories,
        providerServiceApiProtocols: p.providerServiceApiProtocols,
        reputationScore: p.reputationScore,
        trustScore: p.trustScore,
        lastSeen: p.lastSeen,
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, peers: payload }))
      return
    }

    if (path === '/_antseed/connect' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 8192) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      let peerId: string
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        peerId = String(body.peerId ?? '')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      if (!peerId) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Missing peerId' }))
        return
      }
      const peers = await this._getPeers()
      const peer = peers.find((p) => p.peerId === peerId)
      if (!peer) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Peer not found in cache' }))
        return
      }
      try {
        await this._node.connectToPeer(peer)
        log(`Eager connection established to ${peerId.slice(0, 12)}...`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log(`Eager connection failed for ${peerId.slice(0, 12)}...: ${message}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
      return
    }

    if (path.startsWith('/_antseed/channels') && method === 'GET') {
      const all = /[?&]all=1/.test(path)
      const channels = all
        ? this._node.getAllBuyerChannels()
        : this._node.getActiveBuyerChannels()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, channels }))
      return
    }

    if (path.startsWith('/_antseed/buyer-usage') && method === 'GET') {
      const totals = this._node.getBuyerUsageTotals()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, totals }))
      return
    }

    const meteringMatch = path.match(/^\/_antseed\/metering\/(.+)$/)
    if (meteringMatch && method === 'GET') {
      const sellerPeerId = decodeURIComponent(meteringMatch[1]!)
      const stats = this._node.getMeteringStatsByPeer(sellerPeerId)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(stats))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Unknown control-plane endpoint' }))
  }

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'

    log(`${method} ${path}`)

    // Control-plane endpoints — handle before collecting proxy body
    if (path.startsWith('/_antseed/')) {
      return this._handleControlPlane(req, res, method, path)
    }

    // Only proxy known API paths — reject everything else with 404
    const normalizedPath = path.split('?')[0]?.trim().toLowerCase() ?? '/'
    const isKnownApiPath =
      normalizedPath.startsWith('/v1/messages') ||
      normalizedPath.startsWith('/v1/chat/completions') ||
      normalizedPath.startsWith('/v1/responses') ||
      normalizedPath.startsWith('/v1/models')
    if (!isKnownApiPath) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }))
      return
    }

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

    let serializedReq: SerializedHttpRequest = {
      requestId: randomUUID(),
      method,
      path,
      headers,
      body: new Uint8Array(body),
    }

    // Snapshot both session overrides together before any await so a concurrent
    // _reloadSessionOverrides() cannot produce a service/peer mismatch mid-request.
    const effectivePinnedService = this._pinnedService
    const effectivePinnedPeer = this._pinnedPeer
    if (effectivePinnedService) {
      const { body: rewrittenBody, headers: rewrittenHeaders } = rewriteServiceInBody(
        serializedReq.body,
        serializedReq.headers,
        effectivePinnedService,
      )
      if (rewrittenBody !== serializedReq.body) {
        serializedReq = { ...serializedReq, body: rewrittenBody, headers: rewrittenHeaders }
        log(`Service override applied: ${effectivePinnedService}`)
      }
    }

    const clientAbortController = new AbortController()
    const onClientAbort = (): void => {
      if (clientAbortController.signal.aborted) {
        return
      }
      clientAbortController.abort()
      log(`Client disconnected; aborting upstream request reqId=${serializedReq.requestId.slice(0, 8)}`)
    }
    req.once('close', () => {
      if (!req.complete && !res.writableEnded) {
        onClientAbort()
      }
    })
    res.once('close', () => {
      if (!res.writableEnded) {
        onClientAbort()
      }
    })

    const requestProtocol = detectRequestServiceApiProtocol(serializedReq)
    const requestedService = extractRequestedService(serializedReq)
    log(`Routing: protocol=${requestProtocol ?? 'null'} service=${requestedService ?? 'null'}`)
    const explicitProvider = getExplicitProviderOverride(serializedReq)
    const explicitPeerId = getExplicitPeerIdOverride(serializedReq, effectivePinnedPeer ?? undefined)
    log(`Routing hints: provider=${explicitProvider ?? 'auto'} pin-peer=${explicitPeerId ?? 'none'}`)

    // Auto peer selection is disabled. Every request MUST target a specific
    // peer, either via the per-request `x-antseed-pin-peer` header or via a
    // session-wide pin set by `antseed buyer connection set --peer <peerId>`.
    //
    // Surface the error in the structured shape OpenAI/Anthropic SDKs expect
    // (`{ error: { type, code, message, ... } }`) so callers see a proper
    // .message on their error objects instead of a raw text/plain body. We
    // use HTTP 400 — the request is missing required information the buyer
    // cannot infer on its own — which is what SDK retry/error logic treats
    // as a non-retryable client mistake.
    if (!explicitPeerId) {
      log('Request rejected: no peer pinned')
      const errorMessage =
        'No peer pinned. Auto-selection is disabled.\n'
        + 'Pin a peer one of two ways:\n'
        + '  • Per-request header:   x-antseed-pin-peer: <peerId>    (40-char hex EVM address)\n'
        + '  • Session pin:          antseed buyer connection set --peer <peerId>\n'
        + 'Discover peers with:       antseed network browse'
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          type: 'no_peer_pinned',
          code: 'no_peer_pinned',
          message: errorMessage,
          param: 'x-antseed-pin-peer',
          help: {
            perRequestHeader: 'x-antseed-pin-peer: <peerId>',
            sessionPin: 'antseed buyer connection set --peer <peerId>',
            discoverPeers: 'antseed network browse',
          },
        },
      }))
      return
    }

    // Discover peers
    const peers = await this._getPeers()
    if (peers.length === 0) {
      log('No sellers available')
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('No sellers available on the network. Is a seeder running?')
      return
    }

    // Narrow the candidate set to just the pinned peer (if we already know
    // about it) before running the per-peer protocol/service match. This
    // avoids wasting work — and spamming "Service strict-miss" log lines —
    // on every other discovered peer. If the pinned peer isn't in cache yet,
    // fall through with the full list so the "not in candidate set → force
    // refresh" path still works.
    const narrowToPinned = (sources: PeerInfo[]): PeerInfo[] => {
      const match = sources.find((p) => p.peerId.toLowerCase() === explicitPeerId)
      return match ? [match] : sources
    }

    const selectPeers = (candidateSources: PeerInfo[]): CandidatePeerRouteSelection => selectCandidatePeersForRouting(
      narrowToPinned(candidateSources),
      requestProtocol,
      requestedService,
      explicitProvider,
    )

    let hasForcedRefresh = false
    const refreshPeerSelection = async (reason: string): Promise<void> => {
      if (hasForcedRefresh) {
        return
      }
      hasForcedRefresh = true
      log(`Forcing peer refresh before routing after ${reason}.`)
      discoveredPeers = await this._getPeers({ forceRefresh: true })
      ;({
        candidatePeers: routingPeers,
        routePlanByPeerId: routingPlans,
      } = selectPeers(discoveredPeers))
    }

    let {
      candidatePeers,
      routePlanByPeerId,
    } = selectPeers(peers)

    let routingPeers = candidatePeers
    let routingPlans = routePlanByPeerId
    let discoveredPeers = peers

    if (routingPeers.length === 0) {
      await refreshPeerSelection('empty initial routing candidate set')
    }

    if (routingPeers.length === 0) {
      const diagnostics = this._formatPeerSelectionDiagnostics(discoveredPeers)
      const providerLabel = explicitProvider ? ` for provider "${explicitProvider}"` : ''
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`No peers support ${requestProtocol ?? 'this request'}${providerLabel}. ${diagnostics}`)
      return
    }

    log(`Routing candidates: ${routingPeers.length} peer(s)`)

    const router = this._node.router

    // Pinned-peer dispatch (the only path — auto-selection is disabled).
    // Pinned peers must use fresh discovery data so IP changes are picked up.
    // Safe with the hasForcedRefresh guard: if an earlier refresh already ran
    // this request, the cache is already fresh and cacheAgeMs will be < TTL.
    const cacheAgeMs = Date.now() - this._cacheLastUpdatedAtMs
    if (cacheAgeMs > this._peerCacheTtlMs) {
      await refreshPeerSelection(`pinned peer with stale cache (${cacheAgeMs}ms old)`)
    }

    let pinnedRoutingPeers = routingPeers
    let pinnedRoutePlans = routingPlans
    let selectedPeer = pinnedRoutingPeers.find((p) => p.peerId.toLowerCase() === explicitPeerId) ?? null

    if (!selectedPeer) {
      await refreshPeerSelection(`pinned peer ${explicitPeerId.slice(0, 12)}... not in candidate set`)
      pinnedRoutingPeers = routingPeers
      pinnedRoutePlans = routingPlans
      selectedPeer = pinnedRoutingPeers.find((p) => p.peerId.toLowerCase() === explicitPeerId) ?? null
    }

    if (!selectedPeer) {
      const source = serializedReq.headers['x-antseed-pin-peer'] ? 'x-antseed-pin-peer header' : '--peer flag or session pin'
      const peerDiscovered = discoveredPeers.some((peer) => peer.peerId.toLowerCase() === explicitPeerId)
      const protocolLabel = requestProtocol ? `protocol=${requestProtocol}` : 'protocol=unknown'
      const providerLabel = explicitProvider ? `provider=${explicitProvider}` : 'provider=auto'
      const serviceLabel = requestedService ? `service=${requestedService}` : 'service=none'
      const mismatchHint = peerDiscovered
        ? `Peer is discoverable but filtered as incompatible (${protocolLabel}, ${providerLabel}, ${serviceLabel}).`
        : 'Peer is not discoverable right now.'
      log(`Pinned peer ${explicitPeerId.slice(0, 12)}... not found in candidate list (${source})`)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`Pinned peer ${explicitPeerId.slice(0, 12)}... is not available or does not support this request. ${mismatchHint}`)
      return
    }
    log(`Using pinned peer ${selectedPeer.peerId.slice(0, 12)}...`)
    const result = await this._dispatchToPeer(
      res,
      serializedReq,
      selectedPeer,
      pinnedRoutePlans,
      requestProtocol,
      requestedService,
      explicitProvider,
      router,
      RETRYABLE_STATUS_CODES,
      clientAbortController.signal,
    )
    if (!result.done) {
      // Pinned peer returned a retryable error. We never retry against another
      // peer — auto-selection is disabled — so surface the error to the client.
      res.writeHead(result.statusCode, result.responseHeaders)
      res.end(result.responseBody)
    }
  }

  /**
   * Dispatch a request to a specific peer. Returns `{ done: true }` if the response
   * was sent to the client (success or non-retryable error), or retry info if the
   * caller should try another peer.
   */
  private async _dispatchToPeer(
    res: ServerResponse,
    serializedReq: SerializedHttpRequest,
    selectedPeer: PeerInfo,
    routePlanByPeerId: Map<string, PeerProtocolRoutePlan>,
    requestProtocol: ServiceApiProtocol | null,
    requestedService: string | null,
    explicitProvider: string | null,
    router: Router | null,
    retryableStatusCodes: Set<number>,
    requestSignal: AbortSignal,
  ): Promise<
    | { done: true }
    | { done: false; statusCode: number; responseBody: Buffer; responseHeaders: Record<string, string>; errorMessage: string | null }
  > {
    const selectedRoutePlan = routePlanByPeerId.get(selectedPeer.peerId)
      ?? resolvePeerRoutePlan(selectedPeer, requestProtocol, requestedService, explicitProvider)

    if (!selectedRoutePlan) {
      return { done: false, statusCode: 502, responseBody: Buffer.from('No compatible provider route'), responseHeaders: { 'content-type': 'text/plain' }, errorMessage: null }
    }

    const {
      'x-antseed-pin-peer': _pinPeer,
      'x-antseed-prefer-peer': _preferPeer,
      ...headersForPeer
    } = serializedReq.headers
    let requestForPeer: SerializedHttpRequest = {
      ...serializedReq,
      headers: {
        ...headersForPeer,
        'x-antseed-provider': selectedRoutePlan.provider,
      },
    }
    let adaptResponse: ((response: SerializedHttpResponse) => SerializedHttpResponse) | null = null
    let streamResponseAdapter: StreamingResponseAdapter | null = null

    if (selectedRoutePlan.selection?.requiresTransform) {
      const transformKey = `${requestProtocol}→${selectedRoutePlan.selection.targetProtocol}`
      const strategy = PROTOCOL_TRANSFORMS[transformKey]
      if (!strategy) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Unsupported protocol transformation path')
        return { done: true }
      }

      log(`Applying protocol adapter ${transformKey} via provider "${selectedRoutePlan.provider}"`)
      const transformed = strategy.transformRequest(requestForPeer)
      if (!transformed) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`Failed to transform request for ${transformKey}`)
        return { done: true }
      }
      requestForPeer = {
        ...transformed.request,
        headers: {
          ...transformed.request.headers,
          'x-antseed-provider': selectedRoutePlan.provider,
        },
      }
      adaptResponse = (response: SerializedHttpResponse) =>
        strategy.adaptResponse(response, {
          streamRequested: transformed.streamRequested,
          fallbackModel: transformed.requestedModel,
        })
      if (transformed.streamRequested) {
        streamResponseAdapter = strategy.createStreamAdapter({
          fallbackModel: transformed.requestedModel,
        })
      }
    }

    if (DEBUG()) {
      log(`Outbound request shape: ${summarizeRequestShape(requestForPeer)}`)
    }
    log(`Routing to peer ${selectedPeer.peerId.slice(0, 12)}...`)

    // Forward through P2P
    const wantsStreaming = requestWantsStreaming(requestForPeer.headers, requestForPeer.body)
    const startTime = Date.now()
    try {
      if (wantsStreaming) {
        let streamed = false
        const response = await this._node.sendRequestStream(selectedPeer, requestForPeer, {
          onResponseStart: (startResponse: SerializedHttpResponse, metadata: RequestStreamResponseMetadata) => {
            if (!metadata.streaming) return
            streamed = true
            const adaptedStartResponse = streamResponseAdapter
              ? streamResponseAdapter.adaptStart(startResponse)
              : startResponse
            const streamingHeaders = attachStreamingAntseedHeaders(
              adaptedStartResponse.headers,
              selectedPeer,
              requestForPeer.requestId,
            )
            // Ensure content-type is set for SSE — some upstream APIs (e.g. Codex)
            // omit it, which can cause the client's fetch body reader to not
            // detect end-of-stream properly.
            if (!streamingHeaders['content-type']) {
              streamingHeaders['content-type'] = 'text/event-stream'
            }
            res.writeHead(adaptedStartResponse.statusCode, streamingHeaders)
            if (adaptedStartResponse.body.length > 0) {
              res.write(Buffer.from(adaptedStartResponse.body))
            }
          },
          onResponseChunk: (chunk: SerializedHttpResponseChunk) => {
            if (!streamed) return
            const adaptedChunks = streamResponseAdapter
              ? streamResponseAdapter.adaptChunk(chunk)
              : [chunk]
            for (const adaptedChunk of adaptedChunks) {
              if (adaptedChunk.data.length > 0) {
                res.write(Buffer.from(adaptedChunk.data))
              }
            }
          },
        }, { signal: requestSignal })

        let responseForClient = response
        if (!streamed && adaptResponse) {
          responseForClient = adaptResponse(response)
        }
        responseForClient = adaptOpenAICompatibleErrorResponse(responseForClient, requestProtocol)
        if (responseForClient.statusCode === 402) {
          responseForClient = inject402PeerId(responseForClient, selectedPeer.peerId)
        }

        const latencyMs = Date.now() - startTime
        log(`Response: ${responseForClient.statusCode} (${latencyMs}ms, ${responseForClient.body.length} bytes)`)
        if (responseForClient.statusCode >= 400) {
          const prefix = adaptResponse && !streamed ? 'Upstream adapted error detail' : 'Upstream error detail'
          log(`${prefix}: ${summarizeErrorResponse(responseForClient)}`)
        }

        const telemetry = computeResponseTelemetry(
          requestForPeer,
          responseForClient.headers,
          responseForClient.body,
          selectedPeer,
        )
        if (router) {
          router.onResult(selectedPeer, {
            success: !retryableStatusCodes.has(responseForClient.statusCode),
            latencyMs,
            tokens: telemetry.usage.totalTokens,
          })
        }

        if (streamed) {
          // Headers already sent to client, can't retry
          if (responseForClient.statusCode >= 200 && responseForClient.statusCode < 400) {
            this._rememberSuccessfulPeer(selectedPeer.peerId)
          }
          if (!res.writableEnded) {
            res.end()
          }
          return { done: true }
        }

        // Non-streamed response — check if retryable
        const responseHeaders = attachAntseedTelemetryHeaders(
          responseForClient.headers,
          selectedPeer,
          telemetry,
          requestForPeer.requestId,
          latencyMs,
        )
        if (retryableStatusCodes.has(responseForClient.statusCode)) {
          return {
            done: false,
            statusCode: responseForClient.statusCode,
            responseBody: Buffer.from(responseForClient.body),
            responseHeaders,
            errorMessage: null,
          }
        }

        if (responseForClient.statusCode >= 200 && responseForClient.statusCode < 400) {
          this._rememberSuccessfulPeer(selectedPeer.peerId)
        }
        res.writeHead(responseForClient.statusCode, responseHeaders)
        res.end(Buffer.from(responseForClient.body))
        return { done: true }
      } else {
        const upstreamResponse = await this._node.sendRequest(selectedPeer, requestForPeer, { signal: requestSignal })
        if (upstreamResponse.statusCode >= 400 && !adaptResponse) {
          log(`Upstream raw error detail: ${summarizeErrorResponse(upstreamResponse)}`)
        }

        let response = upstreamResponse
        if (adaptResponse) {
          response = adaptResponse(response)
        }
        response = adaptOpenAICompatibleErrorResponse(response, requestProtocol)
        if (response.statusCode === 402) {
          response = inject402PeerId(response, selectedPeer.peerId)
        }
        const latencyMs = Date.now() - startTime

        log(`Response: ${response.statusCode} (${latencyMs}ms, ${response.body.length} bytes)`)
        if (response.statusCode >= 400) {
          const prefix = adaptResponse ? 'Upstream adapted error detail' : 'Upstream error detail'
          log(`${prefix}: ${summarizeErrorResponse(response)}`)
        }

        const telemetry = computeResponseTelemetry(requestForPeer, response.headers, response.body, selectedPeer)
        const responseHeaders = attachAntseedTelemetryHeaders(
          response.headers,
          selectedPeer,
          telemetry,
          requestForPeer.requestId,
          latencyMs,
        )

        // Report result to router for learning
        if (router) {
          router.onResult(selectedPeer, {
            success: !retryableStatusCodes.has(response.statusCode),
            latencyMs,
            tokens: telemetry.usage.totalTokens,
          })
        }

        // Check if retryable
        if (retryableStatusCodes.has(response.statusCode)) {
          return { done: false, statusCode: response.statusCode, responseBody: Buffer.from(response.body), responseHeaders, errorMessage: null }
        }

        if (response.statusCode >= 200 && response.statusCode < 400) {
          this._rememberSuccessfulPeer(selectedPeer.peerId)
        }
        // Forward response headers and body to the HTTP client
        res.writeHead(response.statusCode, responseHeaders)
        res.end(Buffer.from(response.body))
        return { done: true }
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime
      const message = err instanceof Error ? err.message : String(err)
      const abortedLocally = requestSignal.aborted
      const connectionChurnError = isConnectionChurnError(message)
      log(`Request failed after ${latencyMs}ms: ${message}`)

      if (abortedLocally) {
        log(`Request ${requestForPeer.requestId.slice(0, 8)} aborted locally; skipping retry, router penalty, and peer eviction.`)
        if (!res.writableEnded) {
          let responded = false
          if (!res.headersSent) {
            try {
              res.writeHead(499, { 'content-type': 'text/plain' })
              responded = true
            } catch {
              // ignore
            }
          }
          try {
            if (res.writableEnded) {
              // no-op
            } else {
              if (responded) {
                res.end('Request cancelled')
              } else {
                res.end()
              }
              responded = true
            }
          } catch {
            // ignore
          }
        }
        return { done: true }
      }

      if (router) {
        router.onResult(selectedPeer, {
          success: false,
          latencyMs,
          tokens: 0,
        })
      }

      // Avoid poisoning routing cache from control-plane service enumeration failures.
      // Some peers can time out on /v1/models (service probe) while still serving inference paths.
      const normalizedPath = requestForPeer.path.toLowerCase()
      const isControlPlaneServicesRequest = normalizedPath.startsWith('/v1/models')
      if (isControlPlaneServicesRequest) {
        log(`Skipping peer eviction for control-plane failure on ${requestForPeer.path}`)
      } else if (connectionChurnError) {
        const currentState = this._node.getPeerConnectionState(selectedPeer.peerId)
        if (isConnectionHealthy(currentState)) {
          log(
            `Skipping peer eviction after connection churn: peer ${selectedPeer.peerId.slice(0, 12)}... `
            + `has replacement connection state=${currentState}`,
          )
        } else {
          this._evictPeer(selectedPeer.peerId)
        }
      } else {
        // Evict only the failing peer — others remain usable.
        this._evictPeer(selectedPeer.peerId)
      }

      if (res.headersSent) {
        // Headers already sent (streaming), can't retry
        if (!res.writableEnded) {
          res.end()
        }
        return { done: true }
      }

      return { done: false, statusCode: 502, responseBody: Buffer.from(`P2P request failed: ${message}`), responseHeaders: { 'content-type': 'text/plain' }, errorMessage: message }
    }
  }
}
