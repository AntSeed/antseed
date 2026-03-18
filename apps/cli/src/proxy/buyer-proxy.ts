import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  AntseedNode,
  ConnectionState,
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
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  type ServiceApiProtocol,
  selectTargetProtocolForRequest,
  type StreamingResponseAdapter,
  type TargetProtocolSelection,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
} from './service-api-adapter.js'

export interface BuyerProxyConfig {
  port: number
  node: AntseedNode
  /** How often to refresh the peer list from DHT in the background (ms). Default: 300000 (5 min) */
  backgroundRefreshIntervalMs?: number
  /**
   * Max age for the in-memory peer cache before it is treated as stale (ms).
   * Stale caches can still be used for routing while background refresh repopulates.
   * Default: 30000 (30s).
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
   * Can be updated at runtime via `antseed connection set --service`.
   */
  pinnedService?: string
}

const DAEMON_STATE_FILE = join(homedir(), '.antseed', 'daemon.state.json')
const BUYER_STATE_FILE = join(homedir(), '.antseed', 'buyer.state.json')

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
  service: string | null
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
}

type ResponseTelemetry = {
  usage: TokenUsageSummary
  pricing: RoutingPricing
  estimatedCostUsd: number | null
}

type PeerProtocolRoutePlan = {
  provider: string
  selection: TargetProtocolSelection | null
}

export type CandidatePeerRouteSelection = {
  candidatePeers: PeerInfo[]
  routePlanByPeerId: Map<string, PeerProtocolRoutePlan>
}

function getExplicitProviderOverride(request: SerializedHttpRequest): string | null {
  const provider = request.headers['x-antseed-provider']?.trim().toLowerCase()
  return provider && provider.length > 0 ? provider : null
}

function getExplicitPeerIdOverride(
  request: SerializedHttpRequest,
  sessionPinnedPeerId: string | undefined,
): string | null {
  // Per-request header takes priority over session pin
  const header = request.headers['x-antseed-pin-peer']?.trim().toLowerCase()
  if (header && header.length > 0) return header
  return sessionPinnedPeerId?.toLowerCase() ?? null
}

function getPreferredPeerIdHint(request: SerializedHttpRequest): string | null {
  const header = request.headers['x-antseed-prefer-peer']?.trim().toLowerCase()
  if (!header || header.length === 0) {
    return null
  }
  return header
}

function getPeerProviderProtocols(
  peer: PeerInfo,
  provider: string,
  requestedService: string | null,
): ServiceApiProtocol[] {
  const normalizedRequestedService = requestedService?.trim()
  const fromMetadata = (
    peer as PeerInfo & {
      providerServiceApiProtocols?: Record<string, { services: Record<string, ServiceApiProtocol[]> }>
    }
  ).providerServiceApiProtocols?.[provider]?.services
  if (fromMetadata) {
    if (normalizedRequestedService) {
      const directMatchKey = Object.keys(fromMetadata).find(
        (key) => key.toLowerCase() === normalizedRequestedService.toLowerCase(),
      )
      if (directMatchKey && fromMetadata[directMatchKey]?.length) {
        log(
          `Service match: peer ${peer.peerId.slice(0, 8)} provider=${provider} service="${normalizedRequestedService}" `
          + `→ [${fromMetadata[directMatchKey]!.join(',')}]`,
        )
        return Array.from(new Set(fromMetadata[directMatchKey]!))
      }

      if (Object.keys(fromMetadata).length > 0) {
        log(
          `Service strict-miss: peer ${peer.peerId.slice(0, 8)} provider=${provider} service="${normalizedRequestedService}" `
          + 'not in metadata; excluding from route candidates.',
        )
        return []
      }
    }

    const merged = Object.values(fromMetadata).flat()
    if (merged.length > 0) {
      if (requestedService) {
        log(
          `Service hint miss: peer ${peer.peerId.slice(0, 8)} provider=${provider} service="${requestedService}" not in metadata; falling back to provider protocol set [${Array.from(new Set(merged)).join(',')}]`,
        )
      }
      return Array.from(new Set(merged))
    }
  }

  const inferred = inferProviderDefaultServiceApiProtocols(provider)
  log(`No metadata: peer ${peer.peerId.slice(0, 8)} provider=${provider} → inferred [${inferred.join(',')}]`)
  return inferred
}

function resolvePeerRoutePlan(
  peer: PeerInfo,
  requestProtocol: ServiceApiProtocol | null,
  requestedService: string | null,
  explicitProvider: string | null,
): PeerProtocolRoutePlan | null {
  const providers = peer.providers
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider) => provider.length > 0)

  if (providers.length === 0) {
    return null
  }

  if (explicitProvider && !providers.includes(explicitProvider)) {
    return null
  }

  const candidates = explicitProvider ? [explicitProvider] : providers

  if (!requestProtocol) {
    const provider = candidates[0]
    return provider ? { provider, selection: null } : null
  }

  let transformedFallback: PeerProtocolRoutePlan | null = null
  for (const provider of candidates) {
    const supportedProtocols = getPeerProviderProtocols(peer, provider, requestedService)
    const selection = selectTargetProtocolForRequest(requestProtocol, supportedProtocols)
    if (!selection) {
      continue
    }
    if (!selection.requiresTransform) {
      return { provider, selection }
    }
    if (!transformedFallback) {
      transformedFallback = { provider, selection }
    }
  }

  return transformedFallback
}

export function selectCandidatePeersForRouting(
  peers: PeerInfo[],
  requestProtocol: ServiceApiProtocol | null,
  requestedService: string | null,
  explicitProvider: string | null,
): CandidatePeerRouteSelection {
  const routePlanByPeerId = new Map<string, PeerProtocolRoutePlan>()
  if (!requestProtocol && !explicitProvider) {
    return {
      candidatePeers: peers,
      routePlanByPeerId,
    }
  }

  const candidatePeers = peers.filter((peer) => {
    const plan = resolvePeerRoutePlan(peer, requestProtocol, requestedService, explicitProvider)
    if (!plan) return false
    routePlanByPeerId.set(peer.peerId, plan)
    return true
  })

  return {
    candidatePeers,
    routePlanByPeerId,
  }
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
  const explicit = getExplicitProviderOverride(request)
  if (explicit) {
    return explicit
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

function extractRequestedService(request: SerializedHttpRequest): string | null {
  const contentType = (request.headers['content-type'] ?? request.headers['Content-Type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) {
    return null
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>
    const service = parsed.service ?? parsed.model
    if (typeof service === 'string' && service.trim().length > 0) {
      return service.trim()
    }
    return null
  } catch {
    return null
  }
}

function decodeJsonBody(body: Uint8Array): Record<string, unknown> | null {
  if (!body || body.length === 0) {
    return null
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function summarizeMessageShape(messagesRaw: unknown): string {
  if (!Array.isArray(messagesRaw)) {
    return 'msgShape=none'
  }

  const roleCounts = new Map<string, number>()
  const contentKindCounts = new Map<string, number>()
  const blockTypeCounts = new Map<string, number>()
  let invalidMessages = 0
  let firstRole = 'none'
  let lastRole = 'none'

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  for (const entry of messagesRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalidMessages += 1
      continue
    }

    const message = entry as Record<string, unknown>
    const role = typeof message.role === 'string' && message.role.trim().length > 0
      ? message.role.trim().toLowerCase()
      : 'invalid-role'
    bump(roleCounts, role)
    if (firstRole === 'none') {
      firstRole = role
    }
    lastRole = role

    const content = message.content
    if (typeof content === 'string') {
      bump(contentKindCounts, 'string')
      continue
    }
    if (Array.isArray(content)) {
      bump(contentKindCounts, 'array')
      for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          bump(blockTypeCounts, 'invalid')
          continue
        }
        const blockType = typeof (block as Record<string, unknown>).type === 'string'
          ? String((block as Record<string, unknown>).type).trim().toLowerCase()
          : 'missing-type'
        bump(blockTypeCounts, blockType || 'missing-type')
      }
      continue
    }
    if (content && typeof content === 'object') {
      bump(contentKindCounts, 'object')
      continue
    }
    bump(contentKindCounts, 'other')
  }

  const joinMap = (map: Map<string, number>): string => (
    [...map.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, value]) => `${key}:${String(value)}`)
      .join(',')
  )

  const roleSummary = joinMap(roleCounts) || 'none'
  const contentSummary = joinMap(contentKindCounts) || 'none'
  const blockSummary = joinMap(blockTypeCounts) || 'none'

  return [
    `msgShape=roles{${roleSummary}}`,
    `content{${contentSummary}}`,
    `blocks{${blockSummary}}`,
    `firstRole=${firstRole}`,
    `lastRole=${lastRole}`,
    `invalidMsgs=${String(invalidMessages)}`,
  ].join(' ')
}

function summarizeRequestShape(request: SerializedHttpRequest): string {
  const contentType = (request.headers['content-type'] ?? request.headers['Content-Type'] ?? '').toLowerCase()
  const accept = (request.headers['accept'] ?? request.headers['Accept'] ?? '').toLowerCase()
  const providerHeader = request.headers['x-antseed-provider'] ?? 'none'
  const preferPeerHeader = request.headers['x-antseed-prefer-peer'] ?? 'none'
  const service = extractRequestedService(request) ?? 'none'
  const wantsStreaming = requestWantsStreaming(request.headers, request.body)

  const baseParts = [
    `method=${request.method}`,
    `path=${request.path}`,
    `provider=${providerHeader}`,
    `preferPeer=${preferPeerHeader}`,
    `contentType=${contentType || 'none'}`,
    `accept=${accept || 'none'}`,
    `stream=${String(wantsStreaming)}`,
    `service=${service}`,
    `bodyBytes=${String(request.body.length)}`,
  ]

  const jsonBody = decodeJsonBody(request.body)
  if (!jsonBody) {
    return baseParts.join(' ')
  }

  const messagesRaw = jsonBody.messages
  const toolsRaw = jsonBody.tools
  const messageCount = Array.isArray(messagesRaw) ? messagesRaw.length : 0
  const toolCount = Array.isArray(toolsRaw) ? toolsRaw.length : 0
  const maxTokens = Number(jsonBody.max_tokens ?? jsonBody.maxTokens)
  const keys = Object.keys(jsonBody).sort().join(',')

  baseParts.push(`messages=${String(messageCount)}`)
  baseParts.push(`tools=${String(toolCount)}`)
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    baseParts.push(`maxTokens=${String(Math.floor(maxTokens))}`)
  }
  if (keys.length > 0) {
    baseParts.push(`keys=[${keys}]`)
  }
  baseParts.push(summarizeMessageShape(messagesRaw))

  return baseParts.join(' ')
}

function summarizeErrorResponse(response: SerializedHttpResponse): string {
  const contentType = (response.headers['content-type'] ?? '').toLowerCase()
  if (!response.body || response.body.length === 0) {
    return 'empty response body'
  }

  const raw = new TextDecoder().decode(response.body).trim()
  if (raw.length === 0) {
    return 'empty response body'
  }

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const object = parsed as Record<string, unknown>
        const nestedError = object.error && typeof object.error === 'object' && !Array.isArray(object.error)
          ? (object.error as Record<string, unknown>)
          : null
        const message = (
          (typeof nestedError?.message === 'string' && nestedError.message)
          || (typeof object.message === 'string' && object.message)
          || (typeof object.detail === 'string' && object.detail)
        )
        if (message) {
          return `message="${message}"`
        }
      }
    } catch {
      // fall through to raw snippet
    }
  }

  const compact = raw.replace(/\s+/g, ' ')
  const maxChars = 280
  const snippet = compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact
  return `body="${snippet}"`
}

function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function setFiniteNumberHeader(
  headers: Record<string, string>,
  name: string,
  value: unknown,
): void {
  const finite = toFiniteNumberOrNull(value)
  if (finite !== null) {
    headers[name] = String(finite)
  }
}

function setPeerIdentityHeaders(headers: Record<string, string>, selectedPeer: PeerInfo): void {
  headers['x-antseed-peer-id'] = selectedPeer.peerId
  if (selectedPeer.publicAddress) {
    headers['x-antseed-peer-address'] = selectedPeer.publicAddress
  }
  if (selectedPeer.providers.length > 0) {
    headers['x-antseed-peer-providers'] = selectedPeer.providers.join(',')
  }
}

function resolvePeerPricing(peer: PeerInfo, provider: string, service: string | null): { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null } {
  const providerPricing = peer.providerPricing?.[provider]
  if (providerPricing) {
    const servicePricing = service ? providerPricing.services?.[service] : undefined
    if (servicePricing) {
      return {
        inputUsdPerMillion: toFiniteNumberOrNull(servicePricing.inputUsdPerMillion),
        outputUsdPerMillion: toFiniteNumberOrNull(servicePricing.outputUsdPerMillion),
      }
    }
    return {
      inputUsdPerMillion: toFiniteNumberOrNull(providerPricing.defaults.inputUsdPerMillion),
      outputUsdPerMillion: toFiniteNumberOrNull(providerPricing.defaults.outputUsdPerMillion),
    }
  }

  return {
    inputUsdPerMillion: toFiniteNumberOrNull(peer.defaultInputUsdPerMillion),
    outputUsdPerMillion: toFiniteNumberOrNull(peer.defaultOutputUsdPerMillion),
  }
}

function computeResponseTelemetry(
  request: SerializedHttpRequest,
  responseHeaders: Record<string, string>,
  responseBody: Uint8Array,
  selectedPeer: PeerInfo,
): ResponseTelemetry {
  const provider = pickProviderForPeer(selectedPeer, request)
  const service = extractRequestedService(request)
  const pricing = resolvePeerPricing(selectedPeer, provider, service)
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
      service,
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
  setPeerIdentityHeaders(headers, selectedPeer)
  setFiniteNumberHeader(headers, 'x-antseed-peer-reputation', selectedPeer.reputationScore)
  setFiniteNumberHeader(headers, 'x-antseed-peer-trust-score', selectedPeer.trustScore)
  setFiniteNumberHeader(headers, 'x-antseed-peer-current-load', selectedPeer.currentLoad)
  setFiniteNumberHeader(headers, 'x-antseed-peer-max-concurrency', selectedPeer.maxConcurrency)
  headers['x-antseed-provider'] = telemetry.pricing.provider
  if (telemetry.pricing.service) {
    headers['x-antseed-service'] = telemetry.pricing.service
  }
  setFiniteNumberHeader(headers, 'x-antseed-input-usd-per-million', telemetry.pricing.inputUsdPerMillion)
  setFiniteNumberHeader(headers, 'x-antseed-output-usd-per-million', telemetry.pricing.outputUsdPerMillion)
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
  setPeerIdentityHeaders(headers, selectedPeer)
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

function isConnectionChurnError(message: string): boolean {
  return /connection .*?\b(closed|failed)\s+during request\b/i.test(message)
}

function isConnectionHealthy(state: ConnectionState | null): boolean {
  if (!state) {
    return false
  }
  const normalized = String(state).toLowerCase()
  return normalized === 'open' || normalized === 'authenticated' || normalized === 'connecting'
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
 * Rewrite the `service` (and `model` for upstream LLM API compat) fields in a JSON request body.
 * Also updates `content-length` if present in headers.
 * Returns the original body/headers unchanged if the body is not JSON,
 * is empty, or cannot be parsed.
 */
export function rewriteServiceInBody(
  body: Uint8Array,
  headers: Record<string, string>,
  service: string,
): { body: Uint8Array; headers: Record<string, string> } {
  const contentType = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json') || body.length === 0) {
    return { body, headers }
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body, headers }
    }
    const obj = parsed as Record<string, unknown>
    obj['service'] = service
    obj['model'] = service
    const rewritten = new TextEncoder().encode(JSON.stringify(obj))
    const updatedHeaders = { ...headers }
    if ('content-length' in updatedHeaders) {
      updatedHeaders['content-length'] = String(rewritten.length)
    } else if ('Content-Length' in updatedHeaders) {
      updatedHeaders['Content-Length'] = String(rewritten.length)
    }
    return { body: rewritten, headers: updatedHeaders }
  } catch {
    return { body, headers }
  }
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
  private _pinnedPeer: string | null
  private _pinnedService: string | null
  private _stateFileWatcher: FSWatcher | null = null
  private _stateWatchDebounce: ReturnType<typeof setTimeout> | null = null

  private _cachedPeers: PeerInfo[] = []
  private _cacheLastUpdatedAtMs = 0
  private _cacheMutationEpoch = 0
  private _peerRefreshPromise: Promise<PeerInfo[]> | null = null
  private _lastStaleCacheLogAtMs = 0
  private _bgRefreshHandle: ReturnType<typeof setInterval> | null = null
  private _lastSuccessfulPeerId: string | null = null
  private _lastSuccessfulPeerByRouteKey = new Map<string, string>()

  constructor(config: BuyerProxyConfig) {
    this._node = config.node
    this._port = config.port
    this._bgRefreshIntervalMs = config.backgroundRefreshIntervalMs ?? 5 * 60_000
    this._peerCacheTtlMs = Math.max(0, config.peerCacheTtlMs ?? 30_000)
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
    await new Promise<void>((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(this._port, '127.0.0.1', () => {
        this._server.removeListener('error', reject)
        resolve()
      })
    })
    this._startBackgroundRefresh()
    await this._writeStateFile('connected')
    this._watchStateFile()
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
      this._stateFileWatcher = watch(BUYER_STATE_FILE, { persistent: false }, () => {
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
      const raw = await readFile(BUYER_STATE_FILE, 'utf-8')
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

  private async _writeStateFile(state: 'connected' | 'stopped'): Promise<void> {
    try {
      const dir = join(homedir(), '.antseed')
      await mkdir(dir, { recursive: true })
      let existing: Record<string, unknown> = {}
      try {
        const raw = await readFile(BUYER_STATE_FILE, 'utf-8')
        existing = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // file doesn't exist yet
      }
      // When stopping, preserve whatever pinnedService/pinnedPeerId is already
      // in the file — the debounce may have been cancelled before
      // _reloadSessionOverrides could commit the latest CLI-written values.
      const sessionOverrides = state === 'connected'
        ? { pinnedService: this._pinnedService, pinnedPeerId: this._pinnedPeer }
        : {}
      const data = {
        ...existing,
        state,
        pid: process.pid,
        port: this._port,
        ...sessionOverrides,
      }
      const tmp = join(homedir(), '.antseed', `.buyer.state.${randomUUID()}.json.tmp`)
      await writeFile(tmp, JSON.stringify(data, null, 2))
      await rename(tmp, BUYER_STATE_FILE)
    } catch {
      // non-fatal
    }
  }

  private _startBackgroundRefresh(): void {
    this._bgRefreshHandle = setInterval(() => {
      void this._refreshPeersNow().catch(() => {
        // background refresh failure is non-fatal
      })
    }, this._bgRefreshIntervalMs)
  }

  private _replacePeers(incoming: PeerInfo[]): void {
    this._cachedPeers = incoming
    this._cacheLastUpdatedAtMs = Date.now()
    this._cacheMutationEpoch += 1
  }

  private _evictPeer(peerId: string): void {
    const before = this._cachedPeers.length
    this._cachedPeers = this._cachedPeers.filter((p) => p.peerId !== peerId)
    if (this._cachedPeers.length < before) {
      this._cacheLastUpdatedAtMs = Date.now()
      this._cacheMutationEpoch += 1
      log(`Evicted failing peer ${peerId.slice(0, 12)}... from cache (${this._cachedPeers.length} remaining)`)
    }
  }

  private _rememberSuccessfulPeer(routeKey: string, peerId: string): void {
    this._lastSuccessfulPeerId = peerId
    this._lastSuccessfulPeerByRouteKey.set(routeKey, peerId)
    // Keep map bounded to prevent unbounded growth from long-running sessions.
    const MAX_ROUTE_HISTORY = 200
    if (this._lastSuccessfulPeerByRouteKey.size > MAX_ROUTE_HISTORY) {
      const oldestKey = this._lastSuccessfulPeerByRouteKey.keys().next().value
      if (typeof oldestKey === 'string') {
        this._lastSuccessfulPeerByRouteKey.delete(oldestKey)
      }
    }
  }

  private _forgetSuccessfulPeer(routeKey: string, peerId: string): void {
    const rememberedForRoute = this._lastSuccessfulPeerByRouteKey.get(routeKey)
    if (rememberedForRoute === peerId) {
      this._lastSuccessfulPeerByRouteKey.delete(routeKey)
    }
    if (this._lastSuccessfulPeerId === peerId) {
      const stillUsedByOtherRoute = Array.from(this._lastSuccessfulPeerByRouteKey.values())
        .some((rememberedPeerId) => rememberedPeerId === peerId)
      if (!stillUsedByOtherRoute) {
        this._lastSuccessfulPeerId = null
      }
    }
  }

  private _buildRouteKey(
    path: string,
    requestProtocol: ServiceApiProtocol | null,
    requestedService: string | null,
    explicitProvider: string | null,
  ): string {
    const normalizedPath = path.split('?')[0]?.trim().toLowerCase() ?? '/'
    const pathGroup = (
      normalizedPath.startsWith('/v1/messages')
        ? '/v1/messages'
        : normalizedPath.startsWith('/v1/chat/completions')
          ? '/v1/chat/completions'
          : normalizedPath.startsWith('/v1/responses')
            ? '/v1/responses'
            : normalizedPath.startsWith('/v1/models')
              ? '/v1/models'
              : normalizedPath
    )
    return [
      pathGroup,
      requestProtocol ?? 'unknown-protocol',
      requestedService ?? 'unknown-service',
      explicitProvider ?? 'auto-provider',
    ].join('|')
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

  private async _discoverPeersFromNetwork(): Promise<PeerInfo[]> {
    const localSeeder = await this._readLocalSeederFallback()
    if (localSeeder) {
      log(`Using local seeder ${localSeeder.peerId.slice(0, 12)}... @ ${localSeeder.publicAddress} (skipping DHT lookup)`)
      return [localSeeder]
    }

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
      const onChain = Number.isFinite(peer.onChainReputation) ? String(peer.onChainReputation) : 'n/a'
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

    // Discover peers
    const peers = await this._getPeers()
    if (peers.length === 0) {
      log('No sellers available')
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('No sellers available on the network. Is a seeder running?')
      return
    }

    const requestProtocol = detectRequestServiceApiProtocol(serializedReq)
    const requestedService = extractRequestedService(serializedReq)
    log(`Routing: protocol=${requestProtocol ?? 'null'} service=${requestedService ?? 'null'}`)
    const explicitProvider = getExplicitProviderOverride(serializedReq)
    const explicitPeerId = getExplicitPeerIdOverride(serializedReq, effectivePinnedPeer ?? undefined)
    const preferredPeerId = getPreferredPeerIdHint(serializedReq)
    log(
      `Routing hints: provider=${explicitProvider ?? 'auto'} pin-peer=${explicitPeerId ?? 'none'} prefer-peer=${preferredPeerId ?? 'none'}`,
    )
    const routeKey = this._buildRouteKey(serializedReq.path, requestProtocol, requestedService, explicitProvider)
    const selectPeers = (candidateSources: PeerInfo[]): CandidatePeerRouteSelection => selectCandidatePeersForRouting(
      candidateSources,
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
      res.writeHead(502, { 'content-type': 'text/plain' })
      if (requestProtocol) {
        const protocolLabel = requestProtocol
        const providerLabel = explicitProvider ? ` for provider "${explicitProvider}"` : ''
        res.end(`No peers support ${protocolLabel}${providerLabel}. ${diagnostics}`)
      } else {
        res.end(`No peers advertise provider "${explicitProvider}". ${diagnostics}`)
      }
      return
    }

    if (routingPeers.length === 0) {
      const diagnostics = this._formatPeerSelectionDiagnostics(discoveredPeers)
      res.writeHead(502, { 'content-type': 'text/plain' })
      const providerLabel = explicitProvider ? ` for provider "${explicitProvider}"` : ''
      res.end(`No peers support ${requestProtocol ?? 'this request'}${providerLabel}. ${diagnostics}`)
      return
    }

    log(`Routing candidates: ${routingPeers.length} peer(s)`)

    // Select peer: explicit pin bypasses the router (and retry)
    const router = this._node.router
    const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

    if (explicitPeerId) {
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
        const source = serializedReq.headers['x-antseed-pin-peer'] ? 'x-antseed-pin-peer header' : '--peer flag'
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
        routeKey,
        pinnedRoutePlans,
        requestProtocol,
        requestedService,
        explicitProvider,
        router,
        RETRYABLE_STATUS_CODES,
        clientAbortController.signal,
      )
      if (!result.done) {
        this._forgetSuccessfulPeer(routeKey, selectedPeer.peerId)
        // Pinned peer returned a retryable error, but we don't retry — send error to client
        res.writeHead(result.statusCode, result.responseHeaders)
        res.end(result.responseBody)
      }
      return
    }

    // Non-pinned: retry with failover on provider errors
    const MAX_ATTEMPTS = 3
    const triedPeerIds = new Set<string>()
    let lastStatusCode = 502
    let lastResponseBody: Buffer | null = null
    let lastResponseHeaders: Record<string, string> = { 'content-type': 'text/plain' }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const availableCandidates = routingPeers.filter((peer) => !triedPeerIds.has(peer.peerId))
      if (availableCandidates.length === 0) break

      let selectedPeer: PeerInfo | null = null

      // Prefer a recently successful peer for the same request route.
      if (attempt === 0) {
        const routePreferredPeerId = this._lastSuccessfulPeerByRouteKey.get(routeKey)
        if (routePreferredPeerId) {
          const remembered = availableCandidates.find((peer) => peer.peerId === routePreferredPeerId) ?? null
          if (remembered) {
            selectedPeer = remembered
            log(`Reusing last successful route peer ${selectedPeer.peerId.slice(0, 12)}...`)
          }
        }
      }

      // Fallback to the latest globally successful peer.
      if (!selectedPeer && attempt === 0 && this._lastSuccessfulPeerId && !requestedService) {
        const remembered = availableCandidates.find((peer) => peer.peerId === this._lastSuccessfulPeerId) ?? null
        if (remembered) {
          selectedPeer = remembered
          log(`Reusing last successful peer ${selectedPeer.peerId.slice(0, 12)}...`)
        }
      }

      // Soft peer affinity: try caller-preferred peer first, but allow normal fallback.
      if (!selectedPeer && attempt === 0 && preferredPeerId) {
        const preferred = availableCandidates.find((peer) => peer.peerId.toLowerCase() === preferredPeerId) ?? null
        if (preferred) {
          selectedPeer = preferred
          log(`Preferring requested peer ${selectedPeer.peerId.slice(0, 12)}...`)
        }
      }

      // Prefer local peers on first attempt
      if (!selectedPeer && attempt === 0) {
        const localPeers = availableCandidates.filter((peer) => isLoopbackPeer(peer))
        if (localPeers.length > 0) {
          selectedPeer = router
            ? router.selectPeer(serializedReq, localPeers)
            : localPeers[0] ?? null
          if (selectedPeer) {
            log(`Preferring local peer ${selectedPeer.peerId.slice(0, 12)}... @ ${selectedPeer.publicAddress ?? 'unknown'}`)
          }
        }
      }

      // Prefer peers that can serve the request protocol directly without adapter transform.
      if (!selectedPeer && requestProtocol === 'anthropic-messages') {
        const shouldPreferDirect = !requestedService || /claude|anthropic/i.test(requestedService)
        if (shouldPreferDirect) {
          const directPeers = availableCandidates.filter((peer) => {
            const plan = routingPlans.get(peer.peerId)
            if (!plan) return false
            return !plan.selection || !plan.selection.requiresTransform
          })
          if (directPeers.length > 0) {
            selectedPeer = router
              ? router.selectPeer(serializedReq, directPeers)
              : directPeers[0] ?? null
            if (selectedPeer) {
              log(`Preferring direct protocol peer ${selectedPeer.peerId.slice(0, 12)}...`)
            }
          }
        }
      }

      if (!selectedPeer) {
        selectedPeer = router
          ? router.selectPeer(serializedReq, availableCandidates)
          : availableCandidates[0] ?? null
      }

      if (!selectedPeer) break

      triedPeerIds.add(selectedPeer.peerId)

      const result = await this._dispatchToPeer(
        res,
        serializedReq,
        selectedPeer,
        routeKey,
        routingPlans,
        requestProtocol,
        requestedService,
        explicitProvider,
        router,
        RETRYABLE_STATUS_CODES,
        clientAbortController.signal,
      )

      if (result.done) return

      this._forgetSuccessfulPeer(routeKey, selectedPeer.peerId)
      // Request failed with a retryable error — try another peer
      lastStatusCode = result.statusCode
      lastResponseBody = result.responseBody
      lastResponseHeaders = result.responseHeaders

      if (attempt < MAX_ATTEMPTS - 1) {
        log(`Peer ${selectedPeer.peerId.slice(0, 12)}... returned ${result.statusCode}, retrying with another peer (attempt ${attempt + 2}/${MAX_ATTEMPTS})`)
      }
    }

    // All retries exhausted or no peers available
    if (!res.headersSent) {
      if (lastResponseBody) {
        log(`All ${triedPeerIds.size} peer(s) failed, returning last error (${lastStatusCode})`)
        res.writeHead(lastStatusCode, lastResponseHeaders)
        res.end(lastResponseBody)
      } else {
        const diagnostics = this._formatPeerSelectionDiagnostics(routingPeers)
        log('No peers available for request')
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`Router could not select a suitable peer. ${diagnostics}`)
      }
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
    routeKey: string,
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
      if (
        requestProtocol === 'anthropic-messages'
        && selectedRoutePlan.selection.targetProtocol === 'openai-chat-completions'
      ) {
        log(`Applying protocol adapter anthropic-messages -> openai-chat-completions via provider "${selectedRoutePlan.provider}"`)
        const transformed = transformAnthropicMessagesRequestToOpenAIChat(requestForPeer)
        if (!transformed) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('Failed to transform Anthropic request for selected provider protocol')
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
          transformOpenAIChatResponseToAnthropicMessage(response, {
            streamRequested: transformed.streamRequested,
            fallbackModel: transformed.requestedModel,
          })
        if (transformed.streamRequested) {
          streamResponseAdapter = createOpenAIChatToAnthropicStreamingAdapter({
            fallbackModel: transformed.requestedModel,
          })
        }
      } else if (
        requestProtocol === 'openai-responses'
        && selectedRoutePlan.selection.targetProtocol === 'openai-chat-completions'
      ) {
        log(`Applying protocol adapter openai-responses -> openai-chat-completions via provider "${selectedRoutePlan.provider}"`)
        const transformed = transformOpenAIResponsesRequestToOpenAIChat(requestForPeer)
        if (!transformed) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('Failed to transform Responses API request for selected provider protocol')
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
          transformOpenAIChatResponseToOpenAIResponses(response, {
            fallbackModel: transformed.requestedModel,
            streamRequested: transformed.streamRequested,
          })
        if (transformed.streamRequested) {
          streamResponseAdapter = createOpenAIChatToResponsesStreamingAdapter({
            fallbackModel: transformed.requestedModel,
          })
        }
      } else {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Unsupported protocol transformation path')
        return { done: true }
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
            this._rememberSuccessfulPeer(routeKey, selectedPeer.peerId)
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
          this._rememberSuccessfulPeer(routeKey, selectedPeer.peerId)
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
          this._rememberSuccessfulPeer(routeKey, selectedPeer.peerId)
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
      this._forgetSuccessfulPeer(routeKey, selectedPeer.peerId)

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
