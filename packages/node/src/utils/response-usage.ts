import { parseJsonObject, extractUsage } from '@antseed/api-adapter';

/**
 * Parse actual token usage from an LLM provider response body.
 * Handles both JSON and SSE (streaming) responses. Returns zeros
 * if usage data is not found (caller should fall back to estimation).
 */
export function parseResponseUsage(body: Uint8Array): { inputTokens: number; outputTokens: number } {
  const parsed = parseJsonObject(body);
  if (parsed) {
    return extractUsage(parsed);
  }
  const text = new TextDecoder().decode(body);
  let inputTokens = 0;
  let outputTokens = 0;
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
    } catch { /* skip non-JSON lines */ }
  }
  return { inputTokens, outputTokens };
}
