import { describe, it, expect } from 'vitest';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import {
  detectRequestModelApiProtocol,
  inferProviderDefaultModelApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
} from '../src/proxy/model-api-adapter.js';

function makeRequest(overrides?: Partial<SerializedHttpRequest>): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'claude-sonnet',
      max_tokens: 256,
      stream: true,
      system: 'be helpful',
      messages: [
        { role: 'user', content: 'hello' },
      ],
      tools: [
        {
          name: 'write',
          description: 'Write a file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'write' },
    })),
    ...overrides,
  };
}

function makeOpenAIResponse(overrides?: Partial<SerializedHttpResponse>): SerializedHttpResponse {
  return {
    requestId: 'req-1',
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: new TextEncoder().encode(JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'Working on it',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: '{"path":"hello.txt"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
      },
    })),
    ...overrides,
  };
}

describe('detectRequestModelApiProtocol', () => {
  it('detects anthropic messages from path', () => {
    expect(detectRequestModelApiProtocol(makeRequest())).toBe('anthropic-messages');
  });

  it('detects openai chat completions from path', () => {
    expect(
      detectRequestModelApiProtocol(makeRequest({ path: '/v1/chat/completions' })),
    ).toBe('openai-chat-completions');
  });
});

describe('selectTargetProtocolForRequest', () => {
  it('selects passthrough protocol when supported directly', () => {
    const selected = selectTargetProtocolForRequest('anthropic-messages', ['anthropic-messages']);
    expect(selected).toEqual({ targetProtocol: 'anthropic-messages', requiresTransform: false });
  });

  it('selects transform to openai chat when anthropic is unavailable', () => {
    const selected = selectTargetProtocolForRequest('anthropic-messages', ['openai-chat-completions']);
    expect(selected).toEqual({ targetProtocol: 'openai-chat-completions', requiresTransform: true });
  });
});

describe('inferProviderDefaultModelApiProtocols', () => {
  it('infers anthropic providers', () => {
    expect(inferProviderDefaultModelApiProtocols('claude-oauth')).toEqual(['anthropic-messages']);
  });

  it('infers openai-style providers', () => {
    expect(inferProviderDefaultModelApiProtocols('openai')).toEqual(['openai-chat-completions']);
  });
});

describe('transformAnthropicMessagesRequestToOpenAIChat', () => {
  it('rewrites request path/body and strips anthropic-only headers', () => {
    const transformed = transformAnthropicMessagesRequestToOpenAIChat(makeRequest());
    expect(transformed).not.toBeNull();
    expect(transformed!.request.path).toBe('/v1/chat/completions');
    expect(transformed!.streamRequested).toBe(true);
    expect(transformed!.request.headers['anthropic-version']).toBeUndefined();

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet');
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: {
        name: 'write',
      },
    });
  });
});

describe('transformOpenAIChatResponseToAnthropicMessage', () => {
  it('maps non-stream openai chat response to anthropic message payload', () => {
    const transformed = transformOpenAIChatResponseToAnthropicMessage(makeOpenAIResponse(), {
      streamRequested: false,
      fallbackModel: 'fallback-model',
    });
    expect(transformed.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(transformed.body)) as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.stop_reason).toBe('tool_use');
    expect(Array.isArray(body.content)).toBe(true);

    const content = body.content as Array<Record<string, unknown>>;
    expect(content.some((block) => block.type === 'text')).toBe(true);
    expect(content.some((block) => block.type === 'tool_use')).toBe(true);
  });

  it('maps to anthropic SSE when stream is requested', () => {
    const transformed = transformOpenAIChatResponseToAnthropicMessage(makeOpenAIResponse(), {
      streamRequested: true,
      fallbackModel: 'fallback-model',
    });
    expect(transformed.headers['content-type']).toBe('text/event-stream');
    const sseText = new TextDecoder().decode(transformed.body);
    expect(sseText).toContain('event: message_start');
    expect(sseText).toContain('event: content_block_start');
    expect(sseText).toContain('event: message_stop');
  });
});
