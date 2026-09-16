/**
 * Anthropic clients size a conversation against the context window by calling
 * `POST /v1/messages/count_tokens` before a turn. It looks like a completion
 * path but is not one: it must not reach a seller. Routed as a completion it
 * bills a full inference, spends seconds of model time, and answers with a
 * message body where the client expects `{ "input_tokens": n }` — so the tool
 * stalls on every turn that has context to measure.
 *
 * The buyer answers it locally instead, from the same tokenx estimate the
 * pricing layer uses (~95-98% of the real count).
 */

import { estimateTokensFromText } from '@antseed/node'
import { parseJsonObject } from '@antseed/api-adapter'

/** Anthropic's token-count endpoint, on any API version prefix. */
export function isCountTokensPath(path: string): boolean {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '')
  return clean.endsWith('/messages/count_tokens')
}

/**
 * Estimate the prompt tokens an Anthropic `count_tokens` request would bill:
 * system prompt, tool definitions and the full message history. Structural
 * JSON is skipped — only the text a model actually reads is counted.
 */
export function estimateAnthropicPromptTokens(body: Uint8Array): number {
  const parsed = parseJsonObject(body)
  if (!parsed) return 0

  const parts: string[] = []
  collectText(parsed['system'], parts)
  collectText(parsed['messages'], parts)
  for (const tool of asArray(parsed['tools'])) {
    const record = asRecord(tool)
    if (!record) continue
    collectText(record['name'], parts)
    collectText(record['description'], parts)
    // Schemas are read by the model verbatim, punctuation included.
    if (record['input_schema'] !== undefined) parts.push(JSON.stringify(record['input_schema']))
  }

  const text = parts.join('\n')
  return text.length > 0 ? estimateTokensFromText(text) : 0
}

/** Walk any Anthropic content shape (string, block, array of blocks) for text. */
function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value)
    return
  }
  for (const item of asArray(value)) {
    collectText(item, out)
  }
  const record = asRecord(value)
  if (!record) return
  for (const key of ['text', 'content', 'thinking'] as const) {
    if (record[key] !== undefined) collectText(record[key], out)
  }
  // tool_use arguments and tool_result payloads are prompt text too.
  if (record['input'] !== undefined) out.push(JSON.stringify(record['input']))
  if (typeof record['name'] === 'string' && record['type'] === 'tool_use') out.push(record['name'])
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
