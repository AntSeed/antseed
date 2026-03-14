import type { SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import {
  createChatStreamParser,
  encodeJson,
  encodeText,
  encodeSseEvents,
  makeStreamingStartResponse,
  mapFinishReasonToAnthropicStopReason,
  parseChatCompletionResponse,
  parseJsonObject,
  parseJsonSafe,
  toStringContent,
  type StreamingResponseAdapter,
} from './utils.js';

export interface AnthropicToOpenAIRequestTransformResult {
  request: SerializedHttpRequest;
  streamRequested: boolean;
  requestedModel: string | null;
}

// ---------------------------------------------------------------------------
// Anthropic → OpenAI Chat: request conversion helpers
// ---------------------------------------------------------------------------

function convertAnthropicMessagesToOpenAI(body: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];

  if (body.system !== undefined) {
    const systemText = toStringContent(body.system);
    if (systemText.length > 0) {
      out.push({ role: 'system', content: systemText });
    }
  }

  const messagesRaw = body.messages;
  if (!Array.isArray(messagesRaw)) return out;

  for (const messageRaw of messagesRaw) {
    if (!messageRaw || typeof messageRaw !== 'object') continue;
    const message = messageRaw as Record<string, unknown>;
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = message.content;

    if (role === 'assistant' && Array.isArray(content)) {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const blockRaw of content) {
        if (!blockRaw || typeof blockRaw !== 'object') continue;
        const block = blockRaw as Record<string, unknown>;
        if (block.type === 'tool_use') {
          const callName = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool';
          const callId = typeof block.id === 'string' && block.id.length > 0
            ? block.id : `call_${toolCalls.length + 1}`;
          const input = block.input && typeof block.input === 'object' ? block.input : {};
          toolCalls.push({
            id: callId, type: 'function',
            function: { name: callName, arguments: JSON.stringify(input) },
          });
          continue;
        }
        const text = toStringContent(block);
        if (text.length > 0) textParts.push(text);
      }
      out.push({
        role: 'assistant',
        content: textParts.join('\n'),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (role === 'user' && Array.isArray(content)) {
      const textParts: string[] = [];
      const toolResults: Array<Record<string, unknown>> = [];
      for (const blockRaw of content) {
        if (!blockRaw || typeof blockRaw !== 'object') continue;
        const block = blockRaw as Record<string, unknown>;
        if (block.type === 'tool_result') {
          const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          if (toolCallId.length > 0) {
            toolResults.push({ role: 'tool', tool_call_id: toolCallId, content: toStringContent(block.content) });
            continue;
          }
        }
        const text = toStringContent(block);
        if (text.length > 0) textParts.push(text);
      }
      if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('\n') });
      out.push(...toolResults);
      continue;
    }

    out.push({ role, content: toStringContent(content) });
  }

  return out;
}

function convertAnthropicToolsToOpenAI(toolsRaw: unknown): unknown[] | undefined {
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) return undefined;
  const out: unknown[] = [];
  for (const toolRaw of toolsRaw) {
    if (!toolRaw || typeof toolRaw !== 'object') continue;
    const tool = toolRaw as Record<string, unknown>;
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description.length > 0
          ? { description: tool.description } : {}),
        parameters: tool.input_schema && typeof tool.input_schema === 'object'
          ? tool.input_schema : { type: 'object', properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function convertAnthropicToolChoiceToOpenAI(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const choice = toolChoice as Record<string, unknown>;
  const type = typeof choice.type === 'string' ? choice.type : '';
  if (type === 'auto') return 'auto';
  if (type === 'any') return 'required';
  if (type === 'tool' && typeof choice.name === 'string' && choice.name.length > 0) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenAI Chat → Anthropic SSE: build a full stream from a parsed response
// ---------------------------------------------------------------------------

function buildAnthropicStreamFromMessage(message: {
  id: string;
  service: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}): Uint8Array {
  const chunks: string[] = [];
  const pushEvent = (event: string, data: unknown): void => {
    chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  pushEvent('message_start', {
    type: 'message_start',
    message: {
      id: message.id, type: 'message', role: 'assistant', model: message.service,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: message.usage.inputTokens, output_tokens: 0 },
    },
  });

  for (const [index, block] of message.content.entries()) {
    pushEvent('content_block_start', {
      type: 'content_block_start', index,
      content_block: block.type === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    if (block.type === 'text' && block.text.length > 0) {
      pushEvent('content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text },
      });
    }
    if (block.type === 'tool_use') {
      pushEvent('content_block_delta', {
        type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    pushEvent('content_block_stop', { type: 'content_block_stop', index });
  }

  pushEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stopReason, stop_sequence: null },
    usage: { output_tokens: message.usage.outputTokens },
  });
  pushEvent('message_stop', { type: 'message_stop' });

  return encodeText(chunks.join(''));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function transformAnthropicMessagesRequestToOpenAIChat(
  request: SerializedHttpRequest,
): AnthropicToOpenAIRequestTransformResult | null {
  if (!request.path.toLowerCase().startsWith('/v1/messages')) return null;
  const body = parseJsonObject(request.body);
  if (!body) return null;

  const streamRequested = body.stream === true;
  const requestedModel = typeof body.model === 'string' && body.model.trim().length > 0
    ? body.model.trim() : null;

  const transformedBody: Record<string, unknown> = {
    ...(requestedModel ? { model: requestedModel } : {}),
    messages: convertAnthropicMessagesToOpenAI(body),
    stream: streamRequested,
    ...(streamRequested ? { stream_options: { include_usage: true } } : {}),
  };

  if (typeof body.max_tokens === 'number') transformedBody.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') transformedBody.temperature = body.temperature;
  if (typeof body.top_p === 'number') transformedBody.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) transformedBody.stop = body.stop_sequences;
  const mappedTools = convertAnthropicToolsToOpenAI(body.tools);
  if (mappedTools) transformedBody.tools = mappedTools;
  const mappedToolChoice = convertAnthropicToolChoiceToOpenAI(body.tool_choice);
  if (mappedToolChoice !== undefined) transformedBody.tool_choice = mappedToolChoice;
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    transformedBody.metadata = body.metadata;
  }
  if (typeof body.user === 'string') transformedBody.user = body.user;

  const transformedHeaders: Record<string, string> = { ...request.headers };
  for (const headerName of Object.keys(transformedHeaders)) {
    const lower = headerName.toLowerCase();
    if (lower === 'anthropic-version' || lower === 'anthropic-beta') delete transformedHeaders[headerName];
  }
  transformedHeaders['content-type'] = 'application/json';

  return {
    request: { ...request, path: '/v1/chat/completions', headers: transformedHeaders, body: encodeJson(transformedBody) },
    streamRequested,
    requestedModel,
  };
}

export function transformOpenAIChatResponseToAnthropicMessage(
  response: SerializedHttpResponse,
  options: { streamRequested: boolean; fallbackModel?: string | null },
): SerializedHttpResponse {
  const parsed = parseJsonObject(response.body);
  if (!parsed) return response;

  if (response.statusCode >= 400) {
    const openaiError = parsed.error && typeof parsed.error === 'object'
      ? (parsed.error as Record<string, unknown>) : null;
    const message = openaiError && typeof openaiError.message === 'string'
      ? openaiError.message : 'Upstream error';
    const anthropicError = { type: 'error', error: { type: 'api_error', message } };
    return {
      ...response,
      headers: { ...response.headers, 'content-type': options.streamRequested ? 'text/event-stream' : 'application/json' },
      body: options.streamRequested
        ? encodeText(`event: error\ndata: ${JSON.stringify(anthropicError)}\n\n`)
        : encodeJson(anthropicError),
    };
  }

  const chat = parseChatCompletionResponse(parsed, {
    id: `msg_${response.requestId}`,
    model: options.fallbackModel ?? 'unknown',
  });
  const stopReason = mapFinishReasonToAnthropicStopReason(chat.finishReason);

  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  > = [];

  if (chat.textContent.length > 0) {
    contentBlocks.push({ type: 'text', text: chat.textContent });
  }
  for (const tc of chat.toolCalls) {
    const parsedArgs = parseJsonSafe(tc.arguments);
    contentBlocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name || 'tool',
      input: parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)
        ? (parsedArgs as Record<string, unknown>) : { raw: tc.arguments },
    });
  }

  if (options.streamRequested) {
    return {
      ...response,
      headers: { ...response.headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: buildAnthropicStreamFromMessage({
        id: chat.id, service: chat.model, content: contentBlocks,
        stopReason, usage: { inputTokens: chat.inputTokens, outputTokens: chat.outputTokens },
      }),
    };
  }

  return {
    ...response,
    headers: { ...response.headers, 'content-type': 'application/json' },
    body: encodeJson({
      id: chat.id, type: 'message', role: 'assistant', model: chat.model,
      content: contentBlocks, stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: chat.inputTokens, output_tokens: chat.outputTokens },
    }),
  };
}

export function createOpenAIChatToAnthropicStreamingAdapter(
  options: { fallbackModel?: string | null },
): StreamingResponseAdapter {
  let messageStarted = false;
  let textBlockStarted = false;
  let hadTextBlock = false;
  let openToolBlockIndex: number | null = null;
  const emitted: Array<{ event?: string; data: unknown | string }> = [];

  const getToolBlockIndex = (index: number): number => (hadTextBlock ? 1 : 0) + index;

  const startMessage = (): void => {
    if (messageStarted) return;
    messageStarted = true;
    emitted.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: parser.getId(), type: 'message', role: 'assistant', model: parser.getModel(),
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
  };

  const parser = createChatStreamParser({
    onText(delta) {
      startMessage();
      if (!textBlockStarted) {
        textBlockStarted = true;
        hadTextBlock = true;
        emitted.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        });
      }
      emitted.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } },
      });
    },
    onToolCallStart(index, id, name) {
      if (textBlockStarted) {
        emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
        textBlockStarted = false;
      }
      if (openToolBlockIndex !== null && openToolBlockIndex !== index) {
        emitted.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: getToolBlockIndex(openToolBlockIndex) },
        });
      }
      startMessage();
      emitted.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: getToolBlockIndex(index),
          content_block: { type: 'tool_use', id: id || `toolu_${index + 1}`, name: name || 'tool', input: {} },
        },
      });
      openToolBlockIndex = index;
    },
    onToolCallDelta(index, _id, argumentsDelta) {
      emitted.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: getToolBlockIndex(index),
          delta: { type: 'input_json_delta', partial_json: argumentsDelta },
        },
      });
    },
    onFinish(info) {
      if (openToolBlockIndex !== null) {
        emitted.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: getToolBlockIndex(openToolBlockIndex) },
        });
      }
      if (!messageStarted) startMessage();
      if (textBlockStarted) {
        emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
      }
      emitted.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: mapFinishReasonToAnthropicStopReason(info.finishReason), stop_sequence: null },
          usage: { output_tokens: info.outputTokens },
        },
      });
      emitted.push({ event: 'message_stop', data: { type: 'message_stop' } });
    },
  }, {
    id: options.fallbackModel ? `msg_${options.fallbackModel}` : 'msg_stream',
    model: options.fallbackModel ?? 'unknown',
  });

  return {
    adaptStart: makeStreamingStartResponse,
    adaptChunk(chunk) {
      emitted.length = 0;
      parser.feed(chunk.data, chunk.done);
      if (emitted.length > 0) {
        return [{ requestId: chunk.requestId, data: encodeSseEvents(emitted), done: chunk.done }];
      }
      if (chunk.done) {
        return [{ requestId: chunk.requestId, data: new Uint8Array(0), done: true }];
      }
      return [];
    },
  };
}
