import { describe, it, expect } from 'vitest';
import {
  estimateTokensFromContentLength,
  estimateTokensFromStreamBytes,
  estimateTokens,
  BYTES_PER_TOKEN,
  MIN_REQUEST_TOKENS,
  MIN_RESPONSE_TOKENS,
} from '../src/metering/token-counter.js';

describe('estimateTokensFromContentLength', () => {
  it('should return MIN_REQUEST_TOKENS for null content-length (request)', () => {
    expect(estimateTokensFromContentLength(null, 'openai', 'request')).toBe(MIN_REQUEST_TOKENS);
  });

  it('should return MIN_RESPONSE_TOKENS for null content-length (response)', () => {
    expect(estimateTokensFromContentLength(null, 'openai', 'response')).toBe(MIN_RESPONSE_TOKENS);
  });

  it('should return minimum for zero content-length', () => {
    expect(estimateTokensFromContentLength(0, 'openai', 'request')).toBe(MIN_REQUEST_TOKENS);
    expect(estimateTokensFromContentLength(0, 'openai', 'response')).toBe(MIN_RESPONSE_TOKENS);
  });

  it('should estimate tokens from bytes for openai', () => {
    const bytes = 4000; // 4000 bytes / 4.0 bytes-per-token = 1000 tokens
    const result = estimateTokensFromContentLength(bytes, 'openai', 'request');
    expect(result).toBe(1000);
  });

  it('should estimate tokens from bytes for anthropic', () => {
    const bytes = 4200; // 4200 bytes / 4.2 bytes-per-token = 1000 tokens
    const result = estimateTokensFromContentLength(bytes, 'anthropic', 'request');
    expect(result).toBe(1000);
  });

  it('should use default ratio for unknown provider', () => {
    const bytes = 4000;
    const result = estimateTokensFromContentLength(bytes, 'custom', 'request');
    expect(result).toBe(1000); // 4000 / 4.0 = 1000
  });

  it('should enforce minimum for small content', () => {
    // 10 bytes / 4.0 = 3 tokens, but minimum is MIN_REQUEST_TOKENS
    const result = estimateTokensFromContentLength(10, 'openai', 'request');
    expect(result).toBe(MIN_REQUEST_TOKENS);
  });

  it('should ceil the result', () => {
    // 5 bytes / 4.0 = 1.25, ceil = 2, but min = 100
    // Let's use a larger value: 4001 / 4.0 = 1000.25, ceil = 1001
    const result = estimateTokensFromContentLength(4001, 'openai', 'request');
    expect(result).toBe(1001);
  });
});

describe('estimateTokensFromStreamBytes', () => {
  it('should return MIN_RESPONSE_TOKENS for zero bytes', () => {
    expect(estimateTokensFromStreamBytes(0, 'openai')).toBe(MIN_RESPONSE_TOKENS);
  });

  it('should account for SSE overhead (0.82 factor)', () => {
    const totalBytes = 10000;
    const contentBytes = totalBytes * 0.82;
    const expected = Math.max(Math.ceil(contentBytes / 4.0), MIN_RESPONSE_TOKENS);
    expect(estimateTokensFromStreamBytes(totalBytes, 'openai')).toBe(expected);
  });

  it('should use provider-specific ratio', () => {
    const totalBytes = 10000;
    const contentBytes = totalBytes * 0.82;
    const ratio = BYTES_PER_TOKEN['anthropic']!;
    const expected = Math.max(Math.ceil(contentBytes / ratio), MIN_RESPONSE_TOKENS);
    expect(estimateTokensFromStreamBytes(totalBytes, 'anthropic')).toBe(expected);
  });
});

describe('estimateTokens', () => {
  it('should use content-length for non-streaming response', () => {
    const result = estimateTokens(4000, 8000, 'openai', false);
    expect(result.method).toBe('content-length');
    expect(result.confidence).toBe('high');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(2000);
    expect(result.totalTokens).toBe(3000);
  });

  it('should use chunk-accumulation for streaming response', () => {
    const result = estimateTokens(4000, null, 'openai', true, 10000);
    expect(result.method).toBe('chunk-accumulation');
    expect(result.confidence).toBe('medium');
    expect(result.inputTokens).toBe(1000);
  });

  it('should use fallback when no response info available', () => {
    const result = estimateTokens(null, null, 'openai', false);
    expect(result.method).toBe('fallback');
    expect(result.confidence).toBe('low');
    expect(result.inputTokens).toBe(MIN_REQUEST_TOKENS);
    expect(result.outputTokens).toBe(MIN_RESPONSE_TOKENS);
  });

  it('should compute totalTokens as input + output', () => {
    const result = estimateTokens(4000, 4000, 'openai', false);
    expect(result.totalTokens).toBe(result.inputTokens + result.outputTokens);
  });
});

describe('constants', () => {
  it('should have BYTES_PER_TOKEN for known providers', () => {
    expect(BYTES_PER_TOKEN['anthropic']).toBeDefined();
    expect(BYTES_PER_TOKEN['openai']).toBeDefined();
    expect(BYTES_PER_TOKEN['google']).toBeDefined();
    expect(BYTES_PER_TOKEN['moonshot']).toBeDefined();
    expect(BYTES_PER_TOKEN['default']).toBeDefined();
  });

  it('should have reasonable MIN token values', () => {
    expect(MIN_REQUEST_TOKENS).toBe(100);
    expect(MIN_RESPONSE_TOKENS).toBe(10);
  });
});
