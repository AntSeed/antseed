import { extractUsage } from '@antseed/api-adapter'
import type { RoutingUsageObservation } from '@antseed/node'

type ReportedUsage = Pick<RoutingUsageObservation, 'inputTokens' | 'cachedInputTokens'>

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseReportedUsage(value: unknown): ReportedUsage | undefined {
  if (!object(value)) return undefined
  const usages = [value.usage, ...['response', 'message', 'result'].map((key) => object(value[key]) ? value[key].usage : undefined)]
  for (const usage of usages) {
    if (!object(usage)) continue
    const input = usage.prompt_tokens ?? usage.input_tokens
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) continue
    const promptDetails = object(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
    const inputDetails = object(usage.input_tokens_details) ? usage.input_tokens_details : {}
    const cacheFields = [promptDetails.cached_tokens, inputDetails.cached_tokens, usage.cached_input_tokens, usage.cache_read_input_tokens, usage.prompt_cache_hit_tokens]
    const reportedCache = cacheFields.filter((entry) => entry !== undefined)
    const counts = [usage.prompt_tokens, usage.input_tokens, usage.cache_creation_input_tokens, ...reportedCache].filter((entry) => entry !== undefined)
    if (counts.some((entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0)) continue
    const normalized = extractUsage({ usage })
    if (!Number.isSafeInteger(normalized.inputTokens) || normalized.cachedInputTokens > normalized.inputTokens) continue
    return {
      inputTokens: normalized.inputTokens,
      ...(reportedCache.length ? { cachedInputTokens: normalized.cachedInputTokens } : {}),
    }
  }
  return undefined
}

export function extractRoutingUsage(headers: Record<string, string>, body: Uint8Array): ReportedUsage | undefined {
  const text = new TextDecoder().decode(body)
  const streaming = (headers['content-type'] ?? '').includes('text/event-stream') || /^(?:data|event):/u.test(text.trimStart())
  const payloads = streaming
    ? text.split(/\r?\n\r?\n/u).map((event) => event.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'))
    : [text]
  let result: ReportedUsage | undefined
  for (const payload of payloads) {
    if (!payload.trim() || payload.trim() === '[DONE]') continue
    let value: unknown
    try { value = JSON.parse(payload) } catch { continue }
    if (object(value) && (value.error || ['error', 'response.failed', 'response.incomplete'].includes(String(value.type))
      || (object(value.response) && ['failed', 'incomplete'].includes(String(value.response.status))))) return undefined
    const usage = parseReportedUsage(value)
    if (!usage) continue
    const cached = usage.cachedInputTokens ?? result?.cachedInputTokens
    result = {
      inputTokens: Math.max(result?.inputTokens ?? 0, usage.inputTokens),
      ...(cached !== undefined ? { cachedInputTokens: Math.max(result?.cachedInputTokens ?? 0, usage.cachedInputTokens ?? 0) } : {}),
    }
  }
  return result
}
