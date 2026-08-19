import { parseJsonObject, extractUsage, type TokenUsage } from '@antseed/api-adapter';

export type { TokenUsage };
export type ResponseUsage = TokenUsage;

/**
 * Parse actual token usage from an LLM provider response body.
 * Handles both JSON and SSE (streaming) responses. Returns zeros
 * if usage data is not found.
 */
export function parseResponseUsage(body: Uint8Array): ResponseUsage {
  const parsed = parseJsonObject(body);
  if (parsed) {
    return extractUsage(parsed);
  }
  const text = new TextDecoder().decode(body);
  let inputTokens = 0;
  let outputTokens = 0;
  let freshInputTokens = 0;
  let cachedInputTokens = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      const usage = extractUsage(event);
      if (usage.inputTokens > 0) inputTokens = Math.max(inputTokens, usage.inputTokens);
      if (usage.outputTokens > 0) outputTokens = Math.max(outputTokens, usage.outputTokens);
      if (usage.freshInputTokens > 0) freshInputTokens = Math.max(freshInputTokens, usage.freshInputTokens);
      if (usage.cachedInputTokens > 0) cachedInputTokens = Math.max(cachedInputTokens, usage.cachedInputTokens);
    } catch { /* skip non-JSON lines */ }
  }
  return { inputTokens, outputTokens, freshInputTokens, cachedInputTokens };
}
