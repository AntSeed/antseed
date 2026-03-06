import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
  detectRequestModelApiProtocol,
  inferProviderDefaultModelApiProtocols,
  type ModelApiProtocol,
  selectTargetProtocolForRequest,
  type TargetProtocolSelection,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
} from './model-api-adapter.js'

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

type PeerProtocolRoutePlan = {
  provider: string
  selection: TargetProtocolSelection | null
}

export type CandidatePeerRouteSelection = {
  candidatePeers: PeerInfo[]
  routePlanByPeerId: Map<string, PeerProtocolRoutePlan>
}

const CLAUDE_PROVIDER_PREFERENCE = ['claude-oauth', 'anthropic', 'claude-code'] as const

function inferPreferredProvidersForRequest(
  requestProtocol: ModelApiProtocol | null,
  requestedModel: string | null,
): string[] {
  const model = requestedModel?.trim().toLowerCase() ?? ''
  if (model.length === 0) {
    return []
  }

  const providers: string[] = []
  const pushProvider = (value: string | null | undefined): void => {
    const provider = value?.trim().toLowerCase()
    if (!provider || provider.length === 0 || providers.includes(provider)) {
      return
    }
    providers.push(provider)
  }

  const slashIndex = model.indexOf('/')
  if (slashIndex > 0) {
    pushProvider(model.slice(0, slashIndex))
  }

  if (requestProtocol === 'anthropic-messages' || model.startsWith('claude-') || model.includes('claude')) {
    for (const provider of CLAUDE_PROVIDER_PREFERENCE) {
      pushProvider(provider)
    }
  }

  return providers
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
  requestedModel: string | null,
): ModelApiProtocol[] {
  const fromMetadata = (
    peer as PeerInfo & {
      providerModelApiProtocols?: Record<string, { models: Record<string, ModelApiProtocol[]> }>
    }
  ).providerModelApiProtocols?.[provider]?.models
  if (fromMetadata) {
    if (requestedModel && fromMetadata[requestedModel]?.length) {
      log(`Model match: peer ${peer.peerId.slice(0, 8)} provider=${provider} model="${requestedModel}" → [${fromMetadata[requestedModel]!.join(',')}]`)
      return Array.from(new Set(fromMetadata[requestedModel]!))
    }

    const merged = Object.values(fromMetadata).flat()
    if (merged.length > 0) {
      if (requestedModel) {
        log(
          `Model hint miss: peer ${peer.peerId.slice(0, 8)} provider=${provider} model="${requestedModel}" not in metadata; falling back to provider protocol set [${Array.from(new Set(merged)).join(',')}]`,
        )
      }
      return Array.from(new Set(merged))
    }
  }

  const inferred = inferProviderDefaultModelApiProtocols(provider)
  log(`No metadata: peer ${peer.peerId.slice(0, 8)} provider=${provider} → inferred [${inferred.join(',')}]`)
  return inferred
}

function resolvePeerRoutePlan(
  peer: PeerInfo,
  requestProtocol: ModelApiProtocol | null,
  requestedModel: string | null,
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
    const supportedProtocols = getPeerProviderProtocols(peer, provider, requestedModel)
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
  requestProtocol: ModelApiProtocol | null,
  requestedModel: string | null,
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
    const plan = resolvePeerRoutePlan(peer, requestProtocol, requestedModel, explicitProvider)
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
  const model = extractRequestedModel(request) ?? 'none'
  const wantsStreaming = requestWantsStreaming(request.headers, request.body)

  const baseParts = [
    `method=${request.method}`,
    `path=${request.path}`,
    `provider=${providerHeader}`,
    `preferPeer=${preferPeerHeader}`,
    `contentType=${contentType || 'none'}`,
    `accept=${accept || 'none'}`,
    `stream=${String(wantsStreaming)}`,
    `model=${model}`,
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

function resolvePeerPricing(peer: PeerInfo, provider: string, model: string | null): { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null } {
  const providerPricing = peer.providerPricing?.[provider]
  if (providerPricing) {
    const modelPricing = model ? providerPricing.models?.[model] : undefined
    if (modelPricing) {
      return {
        inputUsdPerMillion: toFiniteNumberOrNull(modelPricing.inputUsdPerMillion),
        outputUsdPerMillion: toFiniteNumberOrNull(modelPricing.outputUsdPerMillion),
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
  setPeerIdentityHeaders(headers, selectedPeer)
  setFiniteNumberHeader(headers, 'x-antseed-peer-reputation', selectedPeer.reputationScore)
  setFiniteNumberHeader(headers, 'x-antseed-peer-trust-score', selectedPeer.trustScore)
  setFiniteNumberHeader(headers, 'x-antseed-peer-current-load', selectedPeer.currentLoad)
  setFiniteNumberHeader(headers, 'x-antseed-peer-max-concurrency', selectedPeer.maxConcurrency)
  headers['x-antseed-provider'] = telemetry.pricing.provider
  if (telemetry.pricing.model) {
    headers['x-antseed-model'] = telemetry.pricing.model
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
  return /\b(closed|failed)\s+during request\b/i.test(message)
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
  private readonly _pinnedPeerId: string | undefined

  private _cachedPeers: PeerInfo[] = []
  private _cacheLastUpdatedAtMs = 0
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
    this._pinnedPeerId = config.pinnedPeerId?.toLowerCase()
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
  }

  async stop(): Promise<void> {
    if (this._bgRefreshHandle) {
      clearInterval(this._bgRefreshHandle)
      this._bgRefreshHandle = null
    }
    return new Promise((resolve) => {
      this._server.close(() => resolve())
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
    this._cachedPeers = incoming
    this._cacheLastUpdatedAtMs = Date.now()
  }

  private _evictPeer(peerId: string): void {
    const before = this._cachedPeers.length
    this._cachedPeers = this._cachedPeers.filter((p) => p.peerId !== peerId)
    if (this._cachedPeers.length < before) {
      this._cacheLastUpdatedAtMs = Date.now()
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
    requestProtocol: ModelApiProtocol | null,
    requestedModel: string | null,
    explicitProvider: string | null,
  ): string {
    const normalizedPath = path.split('?')[0]?.trim().toLowerCase() ?? '/'
    const pathGroup = (
      normalizedPath.startsWith('/v1/messages')
        ? '/v1/messages'
        : normalizedPath.startsWith('/v1/chat/completions')
          ? '/v1/chat/completions'
          : normalizedPath.startsWith('/v1/models')
            ? '/v1/models'
            : normalizedPath
    )
    return [
      pathGroup,
      requestProtocol ?? 'unknown-protocol',
      requestedModel ?? 'unknown-model',
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

  private async _discoverAndCachePeers(): Promise<PeerInfo[]> {
    const localSeeder = await this._readLocalSeederFallback()
    if (localSeeder) {
      this._replacePeers([localSeeder])
      log(`Using local seeder ${localSeeder.peerId.slice(0, 12)}... @ ${localSeeder.publicAddress} (skipping DHT lookup)`)
      return this._cachedPeers
    }

    log('Discovering peers via DHT...')
    const peers = await this._node.discoverPeers()
    this._replacePeers(peers)
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
    this._peerRefreshPromise = (async () => {
      const peers = await this._discoverAndCachePeers()
      if (peers.length === 0) {
        const fallbackPeers = this._cachedPeers.length > 0 ? [...this._cachedPeers] : previousCachedPeers
        // Preserve stale cache as fallback when discovery transiently fails.
        if (fallbackPeers.length > 0) {
          log('Discovery returned 0 peers; preserving most-recent cached peers as fallback.')
          this._replacePeers(fallbackPeers)
          return fallbackPeers
        }
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

    const requestProtocol = detectRequestModelApiProtocol(serializedReq)
    const requestedModel = extractRequestedModel(serializedReq)
    log(`Routing: protocol=${requestProtocol ?? 'null'} model=${requestedModel ?? 'null'}`)
    const explicitProvider = getExplicitProviderOverride(serializedReq)
    const explicitPeerId = getExplicitPeerIdOverride(serializedReq, this._pinnedPeerId)
    const preferredPeerId = getPreferredPeerIdHint(serializedReq)
    log(
      `Routing hints: provider=${explicitProvider ?? 'auto'} pin-peer=${explicitPeerId ?? 'none'} prefer-peer=${preferredPeerId ?? 'none'}`,
    )
    const routeKey = this._buildRouteKey(serializedReq.path, requestProtocol, requestedModel, explicitProvider)
    const {
      candidatePeers,
      routePlanByPeerId,
    } = selectCandidatePeersForRouting(peers, requestProtocol, requestedModel, explicitProvider)

    let routingPeers = candidatePeers
    let routingPlans = routePlanByPeerId
    let discoveredPeers = peers

    if (routingPeers.length === 0) {
      // One forced refresh handles stale-cache routing mismatches (e.g. missing provider/model updates).
      discoveredPeers = await this._getPeers({ forceRefresh: true })
      const refreshedSelection = selectCandidatePeersForRouting(
        discoveredPeers,
        requestProtocol,
        requestedModel,
        explicitProvider,
      )
      routingPeers = refreshedSelection.candidatePeers
      routingPlans = refreshedSelection.routePlanByPeerId
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

    const preferredProviders = explicitProvider
      ? []
      : inferPreferredProvidersForRequest(requestProtocol, requestedModel)
    let hasPreferredProviderCandidate = preferredProviders.length > 0
      && routingPeers.some((peer) => {
        const provider = routingPlans.get(peer.peerId)?.provider?.trim().toLowerCase()
        return Boolean(provider && preferredProviders.includes(provider))
      })

    if (preferredProviders.length > 0 && !hasPreferredProviderCandidate) {
      log(
        `No preferred-provider peers in candidate set; forcing refresh for [${preferredProviders.join(',')}] before routing.`,
      )
      discoveredPeers = await this._getPeers({ forceRefresh: true })
      const refreshedSelection = selectCandidatePeersForRouting(
        discoveredPeers,
        requestProtocol,
        requestedModel,
        explicitProvider,
      )
      routingPeers = refreshedSelection.candidatePeers
      routingPlans = refreshedSelection.routePlanByPeerId
      hasPreferredProviderCandidate = routingPeers.some((peer) => {
        const provider = routingPlans.get(peer.peerId)?.provider?.trim().toLowerCase()
        return Boolean(provider && preferredProviders.includes(provider))
      })
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
      let pinnedRoutingPeers = routingPeers
      let pinnedRoutePlans = routingPlans
      let selectedPeer = pinnedRoutingPeers.find((p) => p.peerId.toLowerCase() === explicitPeerId) ?? null

      if (!selectedPeer) {
        log(`Pinned peer ${explicitPeerId.slice(0, 12)}... not in current candidate set; forcing refresh.`)
        discoveredPeers = await this._getPeers({ forceRefresh: true })
        const refreshedSelection = selectCandidatePeersForRouting(
          discoveredPeers,
          requestProtocol,
          requestedModel,
          explicitProvider,
        )
        pinnedRoutingPeers = refreshedSelection.candidatePeers
        pinnedRoutePlans = refreshedSelection.routePlanByPeerId
        selectedPeer = pinnedRoutingPeers.find((p) => p.peerId.toLowerCase() === explicitPeerId) ?? null
      }

      if (!selectedPeer) {
        const source = serializedReq.headers['x-antseed-pin-peer'] ? 'x-antseed-pin-peer header' : '--peer flag'
        const peerDiscovered = discoveredPeers.some((peer) => peer.peerId.toLowerCase() === explicitPeerId)
        const protocolLabel = requestProtocol ? `protocol=${requestProtocol}` : 'protocol=unknown'
        const providerLabel = explicitProvider ? `provider=${explicitProvider}` : 'provider=auto'
        const modelLabel = requestedModel ? `model=${requestedModel}` : 'model=none'
        const mismatchHint = peerDiscovered
          ? `Peer is discoverable but filtered as incompatible (${protocolLabel}, ${providerLabel}, ${modelLabel}).`
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
        requestedModel,
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
    const restrictFailoverToPreferredProviders = preferredProviders.length > 0 && hasPreferredProviderCandidate
    if (restrictFailoverToPreferredProviders) {
      log(`Provider-family preference active (attempt 1): [${preferredProviders.join(',')}]`)
    }
    let lastStatusCode = 502
    let lastResponseBody: Buffer | null = null
    let lastResponseHeaders: Record<string, string> = { 'content-type': 'text/plain' }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const limitToPreferredProviders = restrictFailoverToPreferredProviders && attempt === 0
      if (restrictFailoverToPreferredProviders && attempt === 1) {
        log('Preferred provider attempt failed; expanding failover to all compatible providers.')
      }
      const availableCandidates = routingPeers.filter((peer) => {
        if (triedPeerIds.has(peer.peerId)) {
          return false
        }
        if (!limitToPreferredProviders) {
          return true
        }
        const provider = routingPlans.get(peer.peerId)?.provider?.trim().toLowerCase()
        return Boolean(provider && preferredProviders.includes(provider))
      })
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
      if (!selectedPeer && attempt === 0 && this._lastSuccessfulPeerId && !requestedModel) {
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

      // Strongly prefer providers that match the requested model family (e.g. claude-* -> claude/anthropic providers).
      if (!selectedPeer && attempt === 0 && preferredProviders.length > 0) {
        const providerMatchedPeers = availableCandidates.filter((peer) => {
          const plannedProvider = routingPlans.get(peer.peerId)?.provider?.trim().toLowerCase()
          return plannedProvider ? preferredProviders.includes(plannedProvider) : false
        })
        if (providerMatchedPeers.length > 0) {
          selectedPeer = router
            ? router.selectPeer(serializedReq, providerMatchedPeers)
            : providerMatchedPeers[0] ?? null
          if (selectedPeer) {
            const plannedProvider = routingPlans.get(selectedPeer.peerId)?.provider ?? 'unknown'
            log(
              `Preferring model-matched provider "${plannedProvider}" for model "${requestedModel ?? 'unknown'}"`,
            )
          }
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
        const shouldPreferDirect = !requestedModel || /claude|anthropic/i.test(requestedModel)
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
        requestedModel,
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
    requestProtocol: ModelApiProtocol | null,
    requestedModel: string | null,
    explicitProvider: string | null,
    router: Router | null,
    retryableStatusCodes: Set<number>,
    requestSignal: AbortSignal,
  ): Promise<
    | { done: true }
    | { done: false; statusCode: number; responseBody: Buffer; responseHeaders: Record<string, string>; errorMessage: string | null }
  > {
    const selectedRoutePlan = routePlanByPeerId.get(selectedPeer.peerId)
      ?? resolvePeerRoutePlan(selectedPeer, requestProtocol, requestedModel, explicitProvider)

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
    let forceDisableUpstreamStreaming = false

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
        forceDisableUpstreamStreaming = true
      } else {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Unsupported protocol transformation path')
        return { done: true }
      }
    }

    log(`Outbound request shape: ${summarizeRequestShape(requestForPeer)}`)
    log(`Routing to peer ${selectedPeer.peerId.slice(0, 12)}...`)

    // Forward through P2P
    const wantsStreaming = !forceDisableUpstreamStreaming
      && requestWantsStreaming(requestForPeer.headers, requestForPeer.body)
    const startTime = Date.now()
    try {
      if (wantsStreaming) {
        let streamed = false
        const response = await this._node.sendRequestStream(selectedPeer, requestForPeer, {
          onResponseStart: (startResponse: SerializedHttpResponse, metadata: RequestStreamResponseMetadata) => {
            if (!metadata.streaming) return
            streamed = true
            const streamingHeaders = attachStreamingAntseedHeaders(
              startResponse.headers,
              selectedPeer,
              requestForPeer.requestId,
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
        }, { signal: requestSignal })

        const latencyMs = Date.now() - startTime
        log(`Response: ${response.statusCode} (${latencyMs}ms, ${response.body.length} bytes)`)
        if (response.statusCode >= 400) {
          log(`Upstream error detail: ${summarizeErrorResponse(response)}`)
        }

        const telemetry = computeResponseTelemetry(requestForPeer, response.headers, response.body, selectedPeer)
        if (router) {
          router.onResult(selectedPeer, {
            success: !retryableStatusCodes.has(response.statusCode),
            latencyMs,
            tokens: telemetry.usage.totalTokens,
          })
        }

        if (streamed) {
          // Headers already sent to client, can't retry
          if (response.statusCode >= 200 && response.statusCode < 400) {
            this._rememberSuccessfulPeer(routeKey, selectedPeer.peerId)
          }
          if (!res.writableEnded) {
            res.end()
          }
          return { done: true }
        }

        // Non-streamed response — check if retryable
        const responseHeaders = attachAntseedTelemetryHeaders(
          response.headers,
          selectedPeer,
          telemetry,
          requestForPeer.requestId,
          latencyMs,
        )
        if (retryableStatusCodes.has(response.statusCode)) {
          return { done: false, statusCode: response.statusCode, responseBody: Buffer.from(response.body), responseHeaders, errorMessage: null }
        }

        if (response.statusCode >= 200 && response.statusCode < 400) {
          this._rememberSuccessfulPeer(routeKey, selectedPeer.peerId)
        }
        res.writeHead(response.statusCode, responseHeaders)
        res.end(Buffer.from(response.body))
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
        if (res.headersSent) {
          if (!res.writableEnded) {
            res.end()
          }
          return { done: true }
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

      // Avoid poisoning routing cache from control-plane model enumeration failures.
      // Some peers can time out on /v1/models while still serving inference paths.
      const normalizedPath = requestForPeer.path.toLowerCase()
      const isControlPlaneModelsRequest = normalizedPath.startsWith('/v1/models')
      if (isControlPlaneModelsRequest) {
        log(`Skipping peer eviction for control-plane failure on ${requestForPeer.path}`)
      } else if (connectionChurnError) {
        const currentState = (
          this._node as unknown as { getPeerConnectionState?: (peerId: string) => ConnectionState | null }
        ).getPeerConnectionState?.(selectedPeer.peerId) ?? null
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
