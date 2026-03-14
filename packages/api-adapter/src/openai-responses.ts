import type { SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import {
  createChatStreamParser,
  encodeJson,
  encodeText,
  encodeSseEvents,
  makeStreamingStartResponse,
  parseChatCompletionResponse,
  parseJsonObject,
  toStringContent,
  type StreamingResponseAdapter,
} from './utils.js';
import type { AnthropicToOpenAIRequestTransformResult } from './anthropic.js';

export type ResponsesToOpenAIRequestTransformResult = AnthropicToOpenAIRequestTransformResult;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OpenAIResponsesOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  status: 'completed';
  content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>;
}

interface OpenAIResponsesOutputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

type OpenAIResponsesOutputItem = OpenAIResponsesOutputMessage | OpenAIResponsesOutputFunctionCall;

interface OpenAIResponsesBody {
  id: string;
  object: 'response';
  model: string;
  status: 'completed';
  created_at: number;
  output: OpenAIResponsesOutputItem[];
  output_text: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// OpenAI Responses → OpenAI Chat: request conversion helpers
// ---------------------------------------------------------------------------

function convertResponsesToolsToChatTools(tools: unknown[]): unknown[] | undefined {
  const out: unknown[] = [];
  for (const toolRaw of tools) {
    if (!toolRaw || typeof toolRaw !== 'object') continue;
    const tool = toolRaw as Record<string, unknown>;
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.parameters && typeof tool.parameters === 'object' ? { parameters: tool.parameters } : {}),
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function convertResponsesInputToMessages(body: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];

  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    out.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    out.push({ role: 'user', content: input });
    return out;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const msg = item as Record<string, unknown>;
      const type = typeof msg.type === 'string' ? msg.type : '';

      if (type === 'function_call_output') {
        out.push({
          role: 'tool',
          tool_call_id: typeof msg.call_id === 'string' ? msg.call_id : '',
          content: typeof msg.output === 'string' ? msg.output : toStringContent(msg.output),
        });
        continue;
      }

      if (type === 'function_call') {
        const chatCallId = typeof msg.call_id === 'string' && msg.call_id.length > 0
          ? msg.call_id : (typeof msg.id === 'string' ? msg.id : '');
        out.push({
          role: 'assistant', content: null,
          tool_calls: [{
            id: chatCallId, type: 'function',
            function: {
              name: typeof msg.name === 'string' ? msg.name : '',
              arguments: typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? {}),
            },
          }],
        });
        continue;
      }

      const role = typeof msg.role === 'string' ? msg.role : 'user';
      out.push({ role, content: toStringContent(msg.content) });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// OpenAI Chat → Responses API: response conversion helpers
// ---------------------------------------------------------------------------

function buildOpenAIResponsesBody(
  response: SerializedHttpResponse,
  parsed: Record<string, unknown>,
  options: { fallbackModel?: string | null },
): OpenAIResponsesBody {
  const chat = parseChatCompletionResponse(parsed, {
    id: `resp_${response.requestId}`,
    model: options.fallbackModel ?? 'unknown',
  });

  const outputItems: OpenAIResponsesOutputItem[] = [];
  if (chat.textContent.length > 0) {
    outputItems.push({
      type: 'message', id: `${chat.id}_msg_1`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: chat.textContent, annotations: [] }],
    });
  }
  for (const tc of chat.toolCalls) {
    outputItems.push({
      type: 'function_call', id: tc.id, call_id: tc.id,
      name: tc.name, arguments: tc.arguments, status: 'completed',
    });
  }

  return {
    id: chat.id, object: 'response', model: chat.model, status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    output: outputItems, output_text: chat.textContent,
    usage: {
      input_tokens: chat.inputTokens, output_tokens: chat.outputTokens,
      total_tokens: chat.inputTokens + chat.outputTokens,
    },
  };
}

function buildOpenAIResponsesStream(body: OpenAIResponsesBody): Uint8Array {
  const sseEvents: string[] = [];
  let sequenceNumber = 0;
  const pushEvent = (event: string, data: Record<string, unknown>): void => {
    sseEvents.push(
      `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: sequenceNumber++, ...data })}\n\n`,
    );
  };

  pushEvent('response.created', {
    response: { ...body, status: 'in_progress', output: [], output_text: '' },
  });

  for (const [outputIndex, outputItem] of body.output.entries()) {
    if (outputItem.type === 'message') {
      pushEvent('response.output_item.added', {
        output_index: outputIndex,
        item: { ...outputItem, status: 'in_progress', content: outputItem.content.map((p) => ({ ...p, text: '' })) },
      });
      for (const [contentIndex, part] of outputItem.content.entries()) {
        pushEvent('response.content_part.added', {
          output_index: outputIndex, item_id: outputItem.id, content_index: contentIndex,
          part: { ...part, text: '' },
        });
        pushEvent('response.output_text.delta', {
          output_index: outputIndex, item_id: outputItem.id, content_index: contentIndex,
          delta: part.text, logprobs: [],
        });
        pushEvent('response.output_text.done', {
          output_index: outputIndex, item_id: outputItem.id, content_index: contentIndex,
          text: part.text, logprobs: [],
        });
        pushEvent('response.content_part.done', {
          output_index: outputIndex, item_id: outputItem.id, content_index: contentIndex, part,
        });
      }
      pushEvent('response.output_item.done', { output_index: outputIndex, item: outputItem });
      continue;
    }

    pushEvent('response.output_item.added', {
      output_index: outputIndex, item: { ...outputItem, status: 'in_progress', arguments: '' },
    });
    pushEvent('response.function_call_arguments.delta', {
      output_index: outputIndex, item_id: outputItem.id, call_id: outputItem.call_id,
      delta: outputItem.arguments,
    });
    pushEvent('response.function_call_arguments.done', {
      output_index: outputIndex, item_id: outputItem.id, call_id: outputItem.call_id,
      name: outputItem.name, arguments: outputItem.arguments,
    });
    pushEvent('response.output_item.done', { output_index: outputIndex, item: outputItem });
  }

  pushEvent('response.completed', { response: body });
  sseEvents.push('data: [DONE]\n\n');

  return encodeText(sseEvents.join(''));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function transformOpenAIResponsesRequestToOpenAIChat(
  request: SerializedHttpRequest,
): ResponsesToOpenAIRequestTransformResult | null {
  if (!request.path.toLowerCase().startsWith('/v1/responses')) return null;
  const body = parseJsonObject(request.body);
  if (!body) return null;

  const streamRequested = body.stream === true;
  const requestedModel = typeof body.model === 'string' && body.model.trim().length > 0
    ? body.model.trim() : null;

  const transformedBody: Record<string, unknown> = {
    ...(requestedModel ? { model: requestedModel } : {}),
    messages: convertResponsesInputToMessages(body),
    stream: streamRequested,
    ...(streamRequested ? { stream_options: { include_usage: true } } : {}),
  };

  if (typeof body.max_output_tokens === 'number') transformedBody.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') transformedBody.temperature = body.temperature;
  if (typeof body.top_p === 'number') transformedBody.top_p = body.top_p;
  if (Array.isArray(body.tools)) {
    const chatTools = convertResponsesToolsToChatTools(body.tools);
    if (chatTools) transformedBody.tools = chatTools;
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
      const tcObj = tc as Record<string, unknown>;
      if (tcObj.type === 'function' && typeof tcObj.name === 'string') {
        transformedBody.tool_choice = { type: 'function', function: { name: tcObj.name } };
      } else {
        transformedBody.tool_choice = tc;
      }
    } else {
      transformedBody.tool_choice = tc;
    }
  }
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    transformedBody.metadata = body.metadata;
  }

  return {
    request: {
      ...request, path: '/v1/chat/completions',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: encodeJson(transformedBody),
    },
    streamRequested, requestedModel,
  };
}

export function transformOpenAIChatResponseToOpenAIResponses(
  response: SerializedHttpResponse,
  options: { fallbackModel?: string | null; streamRequested?: boolean },
): SerializedHttpResponse {
  const parsed = parseJsonObject(response.body);
  if (!parsed) return response;

  if (response.statusCode >= 400) {
    const errorPayload = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
    const errorBody = errorPayload === parsed ? parsed : { error: errorPayload };
    if (options.streamRequested) {
      return {
        ...response,
        headers: { ...response.headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: encodeText(`event: error\ndata: ${JSON.stringify(errorBody)}\n\n`),
      };
    }
    return {
      ...response,
      headers: { ...response.headers, 'content-type': 'application/json' },
      body: encodeJson(errorBody),
    };
  }

  const responsesBody = buildOpenAIResponsesBody(response, parsed, options);

  if (!options.streamRequested) {
    return {
      ...response,
      headers: { ...response.headers, 'content-type': 'application/json' },
      body: encodeJson(responsesBody),
    };
  }

  return {
    ...response,
    headers: { ...response.headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: buildOpenAIResponsesStream(responsesBody),
  };
}

export function createOpenAIChatToResponsesStreamingAdapter(
  options: { fallbackModel?: string | null },
): StreamingResponseAdapter {
  let sequenceNumber = 0;
  let responseCreated = false;
  let outputStarted = false;
  let outputDone = false;
  let textBuffer = '';
  const emitted: Array<{ event?: string; data: unknown | string }> = [];

  const pushEvent = (event: string, data: Record<string, unknown>): void => {
    emitted.push({ event, data: { type: event, sequence_number: sequenceNumber++, ...data } });
  };

  const getToolOutputIndex = (index: number): number => index + (outputStarted ? 1 : 0);

  const ensureResponseCreated = (): void => {
    if (responseCreated) return;
    responseCreated = true;
    pushEvent('response.created', {
      response: {
        id: parser.getId(), object: 'response', model: parser.getModel(),
        status: 'in_progress', created_at: Math.floor(Date.now() / 1000),
        output: [], output_text: '',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
  };

  const ensureTextOutputStarted = (): void => {
    ensureResponseCreated();
    if (outputStarted) return;
    outputStarted = true;
    const msgId = `${parser.getId()}_msg_1`;
    pushEvent('response.output_item.added', {
      output_index: 0,
      item: {
        type: 'message', id: msgId, role: 'assistant', status: 'in_progress',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      },
    });
    pushEvent('response.content_part.added', {
      output_index: 0, item_id: msgId, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const parser = createChatStreamParser({
    onText(delta) {
      ensureTextOutputStarted();
      textBuffer += delta;
      pushEvent('response.output_text.delta', {
        output_index: 0, item_id: `${parser.getId()}_msg_1`,
        content_index: 0, delta, logprobs: [],
      });
    },
    onToolCallStart(index, id, name) {
      ensureResponseCreated();
      pushEvent('response.output_item.added', {
        output_index: getToolOutputIndex(index),
        item: { type: 'function_call', id, call_id: id, name, arguments: '', status: 'in_progress' },
      });
    },
    onToolCallDelta(index, id, argumentsDelta) {
      pushEvent('response.function_call_arguments.delta', {
        output_index: getToolOutputIndex(index),
        item_id: id, call_id: id, delta: argumentsDelta,
      });
    },
    onFinish(info) {
      ensureResponseCreated();
      if (outputDone) return;
      outputDone = true;

      const msgId = `${info.id}_msg_1`;
      if (outputStarted) {
        pushEvent('response.output_text.done', {
          output_index: 0, item_id: msgId, content_index: 0, text: textBuffer, logprobs: [],
        });
        pushEvent('response.content_part.done', {
          output_index: 0, item_id: msgId, content_index: 0,
          part: { type: 'output_text', text: textBuffer, annotations: [] },
        });
        pushEvent('response.output_item.done', {
          output_index: 0,
          item: {
            type: 'message', id: msgId, role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: textBuffer, annotations: [] }],
          },
        });
      }

      for (const tc of info.toolCalls) {
        const outputIndex = getToolOutputIndex(tc.index);
        pushEvent('response.function_call_arguments.done', {
          output_index: outputIndex, item_id: tc.id, call_id: tc.id,
          name: tc.name, arguments: tc.arguments,
        });
        pushEvent('response.output_item.done', {
          output_index: outputIndex,
          item: {
            type: 'function_call', id: tc.id, call_id: tc.id,
            name: tc.name, arguments: tc.arguments, status: 'completed',
          },
        });
      }

      pushEvent('response.completed', {
        response: {
          id: info.id, object: 'response', model: info.model,
          status: 'completed', created_at: Math.floor(Date.now() / 1000),
          output: [
            ...(outputStarted ? [{
              type: 'message' as const, id: msgId, role: 'assistant',
              status: 'completed' as const,
              content: [{ type: 'output_text' as const, text: textBuffer, annotations: [] }],
            }] : []),
            ...info.toolCalls.map((tc) => ({
              type: 'function_call' as const, id: tc.id, call_id: tc.id,
              name: tc.name, arguments: tc.arguments, status: 'completed' as const,
            })),
          ],
          output_text: textBuffer,
          usage: {
            input_tokens: info.inputTokens, output_tokens: info.outputTokens,
            total_tokens: info.inputTokens + info.outputTokens,
          },
        },
      });
      emitted.push({ data: '[DONE]' });
    },
  }, {
    id: options.fallbackModel ? `resp_${options.fallbackModel}` : 'resp_stream',
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
