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

  it('handles Venice hybrid shape (prompt_tokens + duplicate cache_read_input_tokens)', () => {
    // Venice's /v1/chat/completions emits both shapes for the same cache hit:
    //   prompt_tokens (total, includes cached)
    //   prompt_tokens_details.cached_tokens (subset)
    //   cache_read_input_tokens (duplicate of the subset)
    // Treating cache_read_input_tokens as an Anthropic-style separate count
    // would double-bill the cached portion at the full input rate.
    const result = extractUsage({
      usage: {
        prompt_tokens: 15926,
        completion_tokens: 6,
        total_tokens: 15932,
        prompt_tokens_details: { cached_tokens: 15616 },
        cache_read_input_tokens: 15616,
      },
    });
    expect(result).toEqual({
      inputTokens: 15926,
      outputTokens: 6,
      freshInputTokens: 310,    // 15926 - 15616, NOT 15926
      cachedInputTokens: 15616,
    });
  });

  it('takes the larger cached count when subset and separate disagree', () => {
    // Defensive: if a provider reports mismatched values, prefer the larger one
    // and still apply subset semantics (since prompt_tokens is present).
    const result = extractUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 600 },
        cache_read_input_tokens: 800,
      },
    });
    expect(result.freshInputTokens).toBe(200);   // 1000 - 800
    expect(result.cachedInputTokens).toBe(800);
  });
});
