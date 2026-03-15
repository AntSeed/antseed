/**
 * Parse raw SSE bytes from a streaming response into a structured response
 * object matching the non-streaming format. Handles both OpenAI and Anthropic SSE.
 */

import type { RequestFormat } from './tools.js';

const decoder = new TextDecoder();

/**
 * Parse OpenAI SSE format into a non-streaming response object.
 *
 * OpenAI SSE lines look like:
 *   data: {"id":"...","choices":[{"delta":{"content":"Hi"}}]}
 *   data: [DONE]
 */
function parseOpenAISSE(sseText: string): Record<string, unknown> {
  let id = '';
  let model = '';
  let content = '';
  let finishReason = '';
  const toolCalls: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[] = [];

  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (chunk.id) id = chunk.id as string;
    if (chunk.model) model = chunk.model as string;

    const choices = chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined;
    const choice = choices?.[0];
    if (!choice) continue;

    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string') content += delta.content;

    const deltaCalls = delta.tool_calls as {
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }[] | undefined;

    if (deltaCalls) {
      for (const tc of deltaCalls) {
        if (tc.id) {
          toolCalls[tc.index] = {
            id: tc.id,
            type: tc.type ?? 'function',
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
          };
        } else if (tc.function?.arguments && toolCalls[tc.index] != null) {
          toolCalls[tc.index]!.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant' };
  if (content) message.content = content;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
}

/**
 * Parse Anthropic SSE format into a non-streaming response object.
 *
 * Anthropic SSE uses event types:
 *   event: content_block_start / content_block_delta / content_block_stop
 *   event: message_delta / message_stop
 */
function parseAnthropicSSE(sseText: string): Record<string, unknown> {
  let id = '';
  let model = '';
  let stopReason = '';
  const contentBlocks: Record<string, unknown>[] = [];

  // Track in-progress blocks by index
  const blockBuilders: Map<number, Record<string, unknown>> = new Map();

  const lines = sseText.split('\n');
  let currentEvent = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
      continue;
    }
    if (!line.startsWith('data: ')) continue;

    let data: Record<string, unknown>;
    const event = currentEvent;
    currentEvent = '';
    try {
      data = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event === 'message_start') {
      const msg = data.message as Record<string, unknown> | undefined;
      if (msg) {
        if (msg.id) id = msg.id as string;
        if (msg.model) model = msg.model as string;
      }
    } else if (event === 'content_block_start') {
      const idx = data.index as number;
      const block = data.content_block as Record<string, unknown>;
      if (block) {
        blockBuilders.set(idx, { ...block });
      }
    } else if (event === 'content_block_delta') {
      const idx = data.index as number;
      const delta = data.delta as Record<string, unknown> | undefined;
      const builder = blockBuilders.get(idx);
      if (delta && builder) {
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          builder.text = ((builder.text as string) ?? '') + delta.text;
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          builder.input_json = ((builder.input_json as string) ?? '') + delta.partial_json;
        }
      }
    } else if (event === 'content_block_stop') {
      const idx = data.index as number;
      const builder = blockBuilders.get(idx);
      if (builder) {
        // For tool_use blocks, parse the accumulated input JSON
        if (builder.type === 'tool_use' && typeof builder.input_json === 'string') {
          try {
            builder.input = JSON.parse(builder.input_json);
          } catch {
            builder.input = {};
          }
          delete builder.input_json;
        }
        contentBlocks[idx] = builder;
        blockBuilders.delete(idx);
      }
    } else if (event === 'message_delta') {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (delta?.stop_reason) stopReason = delta.stop_reason as string;
    }
  }

  return {
    id,
    model,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    stop_reason: stopReason,
  };
}

/**
 * Parse raw SSE bytes into a structured response object.
 */
export function parseSSEResponse(
  sseBytes: Uint8Array,
  format: RequestFormat,
): Record<string, unknown> {
  const text = decoder.decode(sseBytes);

  // If the body looks like plain JSON (no SSE markers), parse it directly.
  // This handles cases where the provider returns a non-streaming response
  // from a streaming endpoint (e.g. error responses, or testing mocks).
  if (!text.includes('data: ') && !text.includes('event: ')) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Fall through to SSE parsing
    }
  }

  return format === 'openai' ? parseOpenAISSE(text) : parseAnthropicSSE(text);
}

