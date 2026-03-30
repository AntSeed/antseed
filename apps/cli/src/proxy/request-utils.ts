import type { ConnectionState, PeerInfo, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node'
import { parseJsonObject } from '@antseed/api-adapter'

const debugEnabled = ['1', 'true', 'yes', 'on'].includes(
  (process.env['ANTSEED_DEBUG'] ?? '').trim().toLowerCase(),
)

export function DEBUG(): boolean {
  return debugEnabled
}

export function log(...args: unknown[]): void {
  if (debugEnabled) console.log('[proxy]', ...args)
}

function getHeader(headers: Record<string, string>, name: string): string {
  return headers[name] ?? headers[name.charAt(0).toUpperCase() + name.slice(1)] ?? ''
}

export function extractRequestedService(request: SerializedHttpRequest): string | null {
  if (!getHeader(request.headers, 'content-type').toLowerCase().includes('application/json')) {
    return null
  }

  const parsed = parseJsonObject(request.body)
  if (!parsed) return null

  const service = parsed.service ?? parsed.model
  if (typeof service === 'string' && service.trim().length > 0) {
    return service.trim()
  }
  return null
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

export function summarizeRequestShape(request: SerializedHttpRequest): string {
  const contentType = getHeader(request.headers, 'content-type').toLowerCase()
  const accept = getHeader(request.headers, 'accept').toLowerCase()
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

  const jsonBody = parseJsonObject(request.body)
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

export function summarizeErrorResponse(response: SerializedHttpResponse): string {
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

export function requestWantsStreaming(headers: Record<string, string>, body: Uint8Array): boolean {
  if (getHeader(headers, 'accept').toLowerCase().includes('text/event-stream')) {
    return true
  }

  if (!getHeader(headers, 'content-type').toLowerCase().includes('application/json') || body.length === 0) {
    return false
  }

  const parsed = parseJsonObject(body)
  return parsed?.stream === true
}

export function isConnectionChurnError(message: string): boolean {
  return /connection .*?\b(closed|failed)\s+during request\b/i.test(message)
}

export function isConnectionHealthy(state: ConnectionState | null): boolean {
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

export function isLoopbackPeer(peer: PeerInfo): boolean {
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
  if (!getHeader(headers, 'content-type').toLowerCase().includes('application/json') || body.length === 0) {
    return { body, headers }
  }
  const obj = parseJsonObject(body)
  if (!obj) {
    return { body, headers }
  }
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
}
