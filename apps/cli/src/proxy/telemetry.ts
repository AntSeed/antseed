import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import { toNonNegativeInt } from '@antseed/api-adapter'
import { pickProviderForPeer } from './routing.js'
import { extractRequestedService } from './request-utils.js'

const decoder = new TextDecoder()

export type TokenUsageSummary = {
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

export type ResponseTelemetry = {
  usage: TokenUsageSummary
  pricing: RoutingPricing
  estimatedCostUsd: number | null
}

function parseUsageObject(value: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } {
  if (!value || typeof value !== 'object') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  }

  const usage = value as Record<string, unknown>
  const total = toNonNegativeInt(usage.totalTokens ?? usage.total_tokens ?? usage.total_token_count)
  let input = toNonNegativeInt(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count
    ?? usage.cache_creation_input_tokens
    ?? usage.cache_read_input_tokens,
  )
  let output = toNonNegativeInt(
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

/** Average ~4 bytes per token for English text; used when providers don't return usage counts. */
const BYTES_PER_TOKEN_ESTIMATE = 4

function estimateTokensFromBytes(inputBytes: number, outputBytes: number): TokenUsageSummary {
  const inputTokens = Math.max(1, Math.round(Math.max(0, inputBytes) / BYTES_PER_TOKEN_ESTIMATE))
  const outputTokens = Math.max(1, Math.round(Math.max(0, outputBytes) / BYTES_PER_TOKEN_ESTIMATE))
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: 'estimated',
  }
}

function parseSseUsage(body: Uint8Array): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const text = decoder.decode(body)
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
    const parsed = JSON.parse(decoder.decode(body)) as Record<string, unknown>
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

export function computeResponseTelemetry(
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

export function attachAntseedTelemetryHeaders(
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

export function attachStreamingAntseedHeaders(
  upstreamHeaders: Record<string, string>,
  selectedPeer: PeerInfo,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...upstreamHeaders }
  headers['x-antseed-request-id'] = requestId
  setPeerIdentityHeaders(headers, selectedPeer)
  return headers
}
