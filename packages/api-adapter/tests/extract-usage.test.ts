import { describe, it, expect } from 'vitest';
import { extractUsage } from '../src/utils.js';

describe('extractUsage', () => {
  it('returns zeros for empty usage', () => {
    const result = extractUsage({});
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 });
  });

  it('parses OpenAI-style usage (no cache)', () => {
    const result = extractUsage({
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, freshInputTokens: 100, cachedInputTokens: 0 });
  });

  it('parses Anthropic-style usage (no cache)', () => {
    const result = extractUsage({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, freshInputTokens: 100, cachedInputTokens: 0 });
  });

  it('parses OpenAI-style cached tokens (prompt_tokens includes cached subset)', () => {
    const result = extractUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      freshInputTokens: 200,  // 1000 - 800
      cachedInputTokens: 800,
    });
  });

  it('parses Anthropic-style cached tokens (input_tokens is fresh-only)', () => {
    const result = extractUsage({
      usage: {
        input_tokens: 200,      // fresh-only
        output_tokens: 100,
        cache_read_input_tokens: 800,
      },
    });
    expect(result).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      freshInputTokens: 200,   // already fresh-only
      cachedInputTokens: 800,
    });
  });

  it('parses Anthropic prompt_cache_hit_tokens (alternative field name)', () => {
    const result = extractUsage({
      usage: {
        input_tokens: 150,
        output_tokens: 75,
        prompt_cache_hit_tokens: 600,
      },
    });
    expect(result).toEqual({
      inputTokens: 150,
      outputTokens: 75,
      freshInputTokens: 150,
      cachedInputTokens: 600,
    });
  });

  it('OpenAI cached tokens never produce negative freshInputTokens', () => {
    // Edge case: cached_tokens > prompt_tokens (shouldn't happen but be safe)
    const result = extractUsage({
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    });
    expect(result.freshInputTokens).toBe(0);
    expect(result.cachedInputTokens).toBe(100);
  });

  it('unwraps OpenAI Responses SSE shape (response.completed event)', () => {
    // The Codex backend's `response.completed` event nests usage under
    // `response`, not at the top level. Without unwrapping, every Responses
    // request was metered as zero tokens.
    const result = extractUsage({
      type: 'response.completed',
      response: {
        id: 'resp_abc',
        model: 'gpt-5.5',
        usage: {
          input_tokens: 22,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 42,
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 22,
      outputTokens: 20,
      freshInputTokens: 22,
      cachedInputTokens: 0,
    });
  });

  it('reads input_tokens_details.cached_tokens (OpenAI Responses cached subset)', () => {
    const result = extractUsage({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 750 },
          output_tokens: 100,
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      freshInputTokens: 250,    // 1000 - 750
      cachedInputTokens: 750,
    });
  });

  it('prefers Anthropic cache field over OpenAI when both present', () => {
    // Anthropic cache_read_input_tokens takes priority since it's checked first
    const result = extractUsage({
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 500,
        prompt_tokens_details: { cached_tokens: 300 },
      },
    });
    // Anthropic style: input_tokens is fresh-only
    expect(result.freshInputTokens).toBe(200);
    expect(result.cachedInputTokens).toBe(500);
  });
});
