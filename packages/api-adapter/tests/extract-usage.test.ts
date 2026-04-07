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
