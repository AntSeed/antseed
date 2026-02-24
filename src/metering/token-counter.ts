import type { ProviderType, TokenCount } from '../types/metering.js';

/**
 * Provider-specific bytes-to-token ratios.
 *
 * These are empirical averages. The actual ratio depends on the
 * tokenizer and content, but for billing estimates they are
 * sufficiently accurate (typically within 10-15%).
 *
 * Rationale:
 * - English text averages ~4 bytes per token across most tokenizers
 * - JSON overhead (keys, brackets, quotes) increases the ratio
 * - Request bodies include system prompts, tool definitions, etc.
 * - Response bodies include JSON wrapping around the actual content
 */
export const BYTES_PER_TOKEN: Record<string, number> = {
  anthropic: 4.2,   // Claude tokenizer, JSON Messages API
  openai: 4.0,      // tiktoken cl100k_base, JSON Chat API
  google: 4.1,      // Gemini tokenizer, JSON generateContent API
  moonshot: 4.0,    // Similar to OpenAI tokenizer
  default: 4.0,     // Fallback for unknown providers
};

/**
 * Minimum token estimate when Content-Length is missing or zero.
 * LLM API requests always have some tokens (at least a system prompt).
 */
export const MIN_REQUEST_TOKENS = 100;
export const MIN_RESPONSE_TOKENS = 10;

/**
 * Estimate token count from HTTP Content-Length header value.
 *
 * @param contentLength - Value of Content-Length header (bytes), or null if absent
 * @param provider - Provider type for selecting bytes-per-token ratio
 * @param direction - Whether this is a request (input) or response (output)
 * @returns Estimated token count
 */
export function estimateTokensFromContentLength(
  contentLength: number | null,
  provider: ProviderType,
  direction: 'request' | 'response'
): number {
  if (contentLength === null || contentLength === 0) {
    return direction === 'request' ? MIN_REQUEST_TOKENS : MIN_RESPONSE_TOKENS;
  }

  const ratio = BYTES_PER_TOKEN[provider] ?? BYTES_PER_TOKEN['default']!;
  return Math.max(
    Math.ceil(contentLength / ratio),
    direction === 'request' ? MIN_REQUEST_TOKENS : MIN_RESPONSE_TOKENS
  );
}

/**
 * Estimate token count from accumulated SSE stream chunk sizes.
 * Used when Content-Length is not available (streaming responses).
 *
 * @param totalBytes - Total bytes received across all SSE chunks
 * @param provider - Provider type
 * @returns Estimated token count
 */
export function estimateTokensFromStreamBytes(
  totalBytes: number,
  provider: ProviderType
): number {
  if (totalBytes === 0) return MIN_RESPONSE_TOKENS;

  const ratio = BYTES_PER_TOKEN[provider] ?? BYTES_PER_TOKEN['default']!;
  // SSE streams have additional overhead: "data: " prefix, newlines, event framing
  // Approximately 15-20% of stream bytes are SSE overhead, not content
  const contentBytes = totalBytes * 0.82;
  return Math.max(Math.ceil(contentBytes / ratio), MIN_RESPONSE_TOKENS);
}

/**
 * Build a complete TokenCount from request and response metadata.
 *
 * @param requestContentLength - Request Content-Length header value (bytes), or null
 * @param responseContentLength - Response Content-Length header value (bytes), or null
 * @param provider - Provider type
 * @param isStreaming - Whether the response was an SSE stream
 * @param streamTotalBytes - Total bytes from stream chunks (only if isStreaming)
 */
export function estimateTokens(
  requestContentLength: number | null,
  responseContentLength: number | null,
  provider: ProviderType,
  isStreaming: boolean,
  streamTotalBytes?: number
): TokenCount {
  const inputTokens = estimateTokensFromContentLength(
    requestContentLength,
    provider,
    'request'
  );

  let outputTokens: number;
  let method: TokenCount['method'];
  let confidence: TokenCount['confidence'];

  if (isStreaming && streamTotalBytes !== undefined) {
    outputTokens = estimateTokensFromStreamBytes(streamTotalBytes, provider);
    method = 'chunk-accumulation';
    confidence = 'medium';
  } else if (responseContentLength !== null && responseContentLength > 0) {
    outputTokens = estimateTokensFromContentLength(
      responseContentLength,
      provider,
      'response'
    );
    method = 'content-length';
    confidence = 'high';
  } else {
    outputTokens = MIN_RESPONSE_TOKENS;
    method = 'fallback';
    confidence = 'low';
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    method,
    confidence,
  };
}
