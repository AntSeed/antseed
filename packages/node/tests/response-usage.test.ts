import { describe, it, expect } from 'vitest';
import { parseResponseUsage } from '../src/utils/response-usage.js';

const enc = new TextEncoder();

describe('parseResponseUsage', () => {
  it('extracts usage from a multi-event Responses SSE stream', () => {
    // Mirrors the shape of a real Codex `response.completed` event:
    // usage is nested under `response`, and cached tokens live under
    // `input_tokens_details.cached_tokens`.
    const stream = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.5"}}',
      '',
      'event: response.in_progress',
      'data: {"type":"response.in_progress","response":{"id":"r1","model":"gpt-5.5"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hi"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r1","model":"gpt-5.5","usage":{"input_tokens":42,"input_tokens_details":{"cached_tokens":10},"output_tokens":7}}}',
      '',
    ].join('\n');
    const usage = parseResponseUsage(enc.encode(stream));
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(7);
    expect(usage.cachedInputTokens).toBe(10);
    expect(usage.freshInputTokens).toBe(32);
  });

  it('returns zeros when the body has no usage field', () => {
    const usage = parseResponseUsage(enc.encode(JSON.stringify({ model: 'foo' })));
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 });
  });
});
