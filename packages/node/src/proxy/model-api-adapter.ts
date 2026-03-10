import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { ModelApiProtocol } from '../types/model-api.js';

const ANTHROPIC_PROVIDER_NAMES = new Set(['anthropic', 'claude-code', 'claude-oauth']);
const OPENAI_CHAT_PROVIDER_NAMES = new Set(['openai', 'local-llm']);

export interface TargetProtocolSelection {
  targetProtocol: ModelApiProtocol;
  requiresTransform: boolean;
}

export interface AnthropicToOpenAIRequestTransformResult {
  request: SerializedHttpRequest;
  streamRequested: boolean;
  requestedModel: string | null;
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function toStringContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return '';
        }
        const block = entry as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (block.type === 'tool_result') {
          return toStringContent(block.content);
        }
        return '';
      })
      .filter((entry) => entry.length > 0)
      .join('\n');
  }
  if (value === null || value === undefined) {
    return '';
  }
  // Handle a single content block object (e.g. {type:'text', text:'...'})
  if (typeof value === 'object') {
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
    if (block.type === 'tool_result') {
      return toStringContent(block.content);
    }
    return '';
  }
  return String(value);
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function mapFinishReasonToAnthropicStopReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (value === 'stop') return 'end_turn';
  if (value === 'length') return 'max_tokens';
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  return value;
}

function toNonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function convertAnthropicMessagesToOpenAI(body: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];

  if (body.system !== undefined) {
    const systemText = toStringContent(body.system);
    if (systemText.length > 0) {
      out.push({ role: 'system', content: systemText });
    }
  }

  const messagesRaw = body.messages;
  if (!Array.isArray(messagesRaw)) {
    return out;
  }

  for (const messageRaw of messagesRaw) {
    if (!messageRaw || typeof messageRaw !== 'object') {
      continue;
    }
    const message = messageRaw as Record<string, unknown>;
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = message.content;

    if (role === 'assistant' && Array.isArray(content)) {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const blockRaw of content) {
        if (!blockRaw || typeof blockRaw !== 'object') {
          continue;
        }
        const block = blockRaw as Record<string, unknown>;
        const blockType = typeof block.type === 'string' ? block.type : '';
        if (blockType === 'tool_use') {
          const callName = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool';
          const callId = typeof block.id === 'string' && block.id.length > 0
            ? block.id
            : `call_${toolCalls.length + 1}`;
          const input = block.input && typeof block.input === 'object' ? block.input : {};
          toolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: callName,
              arguments: JSON.stringify(input),
            },
          });
          continue;
        }
        const text = toStringContent(block);
        if (text.length > 0) {
          textParts.push(text);
        }
      }

      const assistantMessage: Record<string, unknown> = {
        role: 'assistant',
        content: textParts.join('\n'),
      };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      out.push(assistantMessage);
      continue;
    }

    if (role === 'user' && Array.isArray(content)) {
      const textParts: string[] = [];
      const toolResults: Array<Record<string, unknown>> = [];
      for (const blockRaw of content) {
        if (!blockRaw || typeof blockRaw !== 'object') {
          continue;
        }
        const block = blockRaw as Record<string, unknown>;
        const blockType = typeof block.type === 'string' ? block.type : '';
        if (blockType === 'tool_result') {
          const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          if (toolCallId.length > 0) {
            toolResults.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: toStringContent(block.content),
            });
            continue;
          }
        }
        const text = toStringContent(block);
        if (text.length > 0) {
          textParts.push(text);
        }
      }
      if (textParts.length > 0) {
        out.push({
          role: 'user',
          content: textParts.join('\n'),
        });
      }
      out.push(...toolResults);
      continue;
    }

    out.push({
      role,
      content: toStringContent(content),
    });
  }

  return out;
}

function convertAnthropicToolsToOpenAI(toolsRaw: unknown): unknown[] | undefined {
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) {
    return undefined;
  }

  const out: unknown[] = [];
  for (const toolRaw of toolsRaw) {
    if (!toolRaw || typeof toolRaw !== 'object') {
      continue;
    }
    const tool = toolRaw as Record<string, unknown>;
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      continue;
    }
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description.length > 0
          ? { description: tool.description }
          : {}),
        parameters: tool.input_schema && typeof tool.input_schema === 'object'
          ? tool.input_schema
          : { type: 'object', properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function convertAnthropicToolChoiceToOpenAI(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
      return toolChoice;
    }
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object') {
    return undefined;
  }
  const choice = toolChoice as Record<string, unknown>;
  const type = typeof choice.type === 'string' ? choice.type : '';
  if (type === 'auto') {
    return 'auto';
  }
  if (type === 'any') {
    return 'required';
  }
  if (type === 'tool' && typeof choice.name === 'string' && choice.name.length > 0) {
    return {
      type: 'function',
      function: {
        name: choice.name,
      },
    };
  }
  return undefined;
}

function buildAnthropicStreamFromMessage(message: {
  id: string;
  model: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}): Uint8Array {
  const chunks: string[] = [];
  const pushEvent = (event: string, data: unknown): void => {
    chunks.push(`event: ${event}\n`);
    chunks.push(`data: ${JSON.stringify(data)}\n\n`);
  };

  pushEvent('message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.inputTokens,
        output_tokens: 0,
      },
    },
  });

  message.content.forEach((block, index) => {
    pushEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: block.type === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });

    if (block.type === 'text' && block.text.length > 0) {
      pushEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'text_delta',
          text: block.text,
        },
      });
    }

    if (block.type === 'tool_use') {
      pushEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      });
    }

    pushEvent('content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  });

  pushEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: message.usage.outputTokens,
    },
  });

  pushEvent('message_stop', {
    type: 'message_stop',
  });

  return new TextEncoder().encode(chunks.join(''));
}

export function detectRequestModelApiProtocol(request: Pick<SerializedHttpRequest, 'path' | 'headers'>): ModelApiProtocol | null {
  const normalizedPath = request.path.toLowerCase();
  if (normalizedPath.startsWith('/v1/messages') || normalizedPath.startsWith('/v1/complete')) {
    return 'anthropic-messages';
  }
  if (normalizedPath.startsWith('/v1/chat/completions')) {
    return 'openai-chat-completions';
  }
  if (normalizedPath.startsWith('/v1/completions')) {
    return 'openai-completions';
  }
  if (normalizedPath.startsWith('/v1/responses')) {
    return 'openai-responses';
  }

  const hasAnthropicVersionHeader = Object.keys(request.headers)
    .some((key) => key.toLowerCase() === 'anthropic-version');
  if (hasAnthropicVersionHeader) {
    return 'anthropic-messages';
  }

  return null;
}

export function inferProviderDefaultModelApiProtocols(providerName: string): ModelApiProtocol[] {
  const normalized = providerName.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  if (ANTHROPIC_PROVIDER_NAMES.has(normalized)) {
    return ['anthropic-messages'];
  }
  if (OPENAI_CHAT_PROVIDER_NAMES.has(normalized)) {
    return ['openai-chat-completions'];
  }
  return [];
}

export function selectTargetProtocolForRequest(
  requestProtocol: ModelApiProtocol | null,
  supportedProtocols: ModelApiProtocol[],
): TargetProtocolSelection | null {
  if (!requestProtocol) {
    return null;
  }
  if (supportedProtocols.includes(requestProtocol)) {
    return { targetProtocol: requestProtocol, requiresTransform: false };
  }
  if (requestProtocol === 'anthropic-messages' && supportedProtocols.includes('openai-chat-completions')) {
    return { targetProtocol: 'openai-chat-completions', requiresTransform: true };
  }
  if (requestProtocol === 'openai-responses' && supportedProtocols.includes('openai-chat-completions')) {
    return { targetProtocol: 'openai-chat-completions', requiresTransform: true };
  }
  return null;
}

export function transformAnthropicMessagesRequestToOpenAIChat(
  request: SerializedHttpRequest,
): AnthropicToOpenAIRequestTransformResult | null {
  if (!request.path.toLowerCase().startsWith('/v1/messages')) {
    return null;
  }
  const body = parseJsonObject(request.body);
  if (!body) {
    return null;
  }

  const streamRequested = body.stream === true;
  const requestedModel = typeof body.model === 'string' && body.model.trim().length > 0
    ? body.model.trim()
    : null;
  const mappedMessages = convertAnthropicMessagesToOpenAI(body);
  const mappedTools = convertAnthropicToolsToOpenAI(body.tools);
  const mappedToolChoice = convertAnthropicToolChoiceToOpenAI(body.tool_choice);

  const transformedBody: Record<string, unknown> = {
    ...(requestedModel ? { model: requestedModel } : {}),
    messages: mappedMessages,
    stream: false,
  };

  if (typeof body.max_tokens === 'number') {
    transformedBody.max_tokens = body.max_tokens;
  }
  if (typeof body.temperature === 'number') {
    transformedBody.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number') {
    transformedBody.top_p = body.top_p;
  }
  if (Array.isArray(body.stop_sequences)) {
    transformedBody.stop = body.stop_sequences;
  }
  if (mappedTools) {
    transformedBody.tools = mappedTools;
  }
  if (mappedToolChoice !== undefined) {
    transformedBody.tool_choice = mappedToolChoice;
  }
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    transformedBody.metadata = body.metadata;
  }
  if (typeof body.user === 'string') {
    transformedBody.user = body.user;
  }

  const transformedHeaders: Record<string, string> = { ...request.headers };
  for (const headerName of Object.keys(transformedHeaders)) {
    const lower = headerName.toLowerCase();
    if (lower === 'anthropic-version' || lower === 'anthropic-beta') {
      delete transformedHeaders[headerName];
    }
  }
  transformedHeaders['content-type'] = 'application/json';

  return {
    request: {
      ...request,
      path: '/v1/chat/completions',
      headers: transformedHeaders,
      body: encodeJson(transformedBody),
    },
    streamRequested,
    requestedModel,
  };
}

export function transformOpenAIChatResponseToAnthropicMessage(
  response: SerializedHttpResponse,
  options: { streamRequested: boolean; fallbackModel?: string | null },
): SerializedHttpResponse {
  const parsed = parseJsonObject(response.body);
  if (!parsed) {
    return response;
  }

  if (response.statusCode >= 400) {
    const openaiError = parsed.error && typeof parsed.error === 'object'
      ? (parsed.error as Record<string, unknown>)
      : null;
    const message = openaiError && typeof openaiError.message === 'string'
      ? openaiError.message
      : 'Upstream error';
    const anthropicError = {
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    };
    return {
      ...response,
      headers: {
        ...response.headers,
        'content-type': options.streamRequested ? 'text/event-stream' : 'application/json',
      },
      body: options.streamRequested
        ? new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(anthropicError)}\n\n`)
        : encodeJson(anthropicError),
    };
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as Record<string, unknown>)
    : null;
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? (firstChoice.message as Record<string, unknown>)
    : null;
  const finishReason = mapFinishReasonToAnthropicStopReason(firstChoice?.finish_reason);

  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  > = [];

  const textContent = toStringContent(message?.content);
  if (textContent.length > 0) {
    contentBlocks.push({ type: 'text', text: textContent });
  }

  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const [index, toolCallRaw] of toolCalls.entries()) {
      if (!toolCallRaw || typeof toolCallRaw !== 'object') {
        continue;
      }
      const toolCall = toolCallRaw as Record<string, unknown>;
      const functionPayload = toolCall.function && typeof toolCall.function === 'object'
        ? (toolCall.function as Record<string, unknown>)
        : {};
      const id = typeof toolCall.id === 'string' && toolCall.id.length > 0
        ? toolCall.id
        : `toolu_${index + 1}`;
      const name = typeof functionPayload.name === 'string' && functionPayload.name.length > 0
        ? functionPayload.name
        : 'tool';
      const argsRaw = typeof functionPayload.arguments === 'string' ? functionPayload.arguments : '{}';
      const parsedArgs = parseJsonSafe(argsRaw);
      contentBlocks.push({
        type: 'tool_use',
        id,
        name,
        input: parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)
          ? (parsedArgs as Record<string, unknown>)
          : { raw: argsRaw },
      });
  }

  const usage = parsed.usage && typeof parsed.usage === 'object'
    ? (parsed.usage as Record<string, unknown>)
    : {};
  const inputTokens = toNonNegativeInt(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens);

  const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : `msg_${response.requestId}`;
  const model = typeof parsed.model === 'string' && parsed.model.length > 0
    ? parsed.model
    : (options.fallbackModel ?? 'unknown');

  const anthropicMessage = {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };

  if (options.streamRequested) {
    return {
      ...response,
      headers: {
        ...response.headers,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: buildAnthropicStreamFromMessage({
        id,
        model,
        content: contentBlocks,
        stopReason: finishReason,
        usage: {
          inputTokens,
          outputTokens,
        },
      }),
    };
  }

  return {
    ...response,
    headers: {
      ...response.headers,
      'content-type': 'application/json',
    },
    body: encodeJson(anthropicMessage),
  };
}

// ---------------------------------------------------------------------------
// OpenAI Responses API ↔ OpenAI Chat Completions transforms
// ---------------------------------------------------------------------------

export interface ResponsesToOpenAIRequestTransformResult {
  request: SerializedHttpRequest;
  streamRequested: boolean;
  requestedModel: string | null;
}

function convertResponsesToolsToChatTools(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const toolRaw of tools) {
    if (!toolRaw || typeof toolRaw !== 'object') {
      continue;
    }
    const tool = toolRaw as Record<string, unknown>;
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      continue;
    }
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.parameters && typeof tool.parameters === 'object' ? { parameters: tool.parameters } : {}),
      },
    });
  }
  return out;
}

function convertResponsesInputToMessages(body: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];

  // "instructions" maps to a system message
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    out.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;

  // Simple string input → single user message
  if (typeof input === 'string') {
    out.push({ role: 'user', content: input });
    return out;
  }

  // Array of message objects
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const msg = item as Record<string, unknown>;
      const type = typeof msg.type === 'string' ? msg.type : '';

      // function_call_output → tool role message with tool_call_id
      if (type === 'function_call_output') {
        out.push({
          role: 'tool',
          tool_call_id: typeof msg.call_id === 'string' ? msg.call_id : '',
          content: typeof msg.output === 'string' ? msg.output : toStringContent(msg.output),
        });
        continue;
      }

      // function_call → assistant message with tool_calls
      if (type === 'function_call') {
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: typeof msg.id === 'string' ? msg.id : '',
            type: 'function',
            function: {
              name: typeof msg.name === 'string' ? msg.name : '',
              arguments: typeof msg.arguments === 'string' ? msg.arguments : '{}',
            },
          }],
        });
        continue;
      }

      const role = typeof msg.role === 'string' ? msg.role : 'user';
      out.push({ role, content: toStringContent(msg.content) });
    }
    return out;
  }

  return out;
}

export function transformOpenAIResponsesRequestToOpenAIChat(
  request: SerializedHttpRequest,
): ResponsesToOpenAIRequestTransformResult | null {
  if (!request.path.toLowerCase().startsWith('/v1/responses')) {
    return null;
  }
  const body = parseJsonObject(request.body);
  if (!body) {
    return null;
  }

  const streamRequested = body.stream === true;
  const requestedModel = typeof body.model === 'string' && body.model.trim().length > 0
    ? body.model.trim()
    : null;

  const messages = convertResponsesInputToMessages(body);

  const transformedBody: Record<string, unknown> = {
    ...(requestedModel ? { model: requestedModel } : {}),
    messages,
    stream: false,
    // TODO: forward store from the Responses request once our client supports it
    store: false,
  };

  if (typeof body.max_output_tokens === 'number') {
    transformedBody.max_tokens = body.max_output_tokens;
  }
  if (typeof body.temperature === 'number') {
    transformedBody.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number') {
    transformedBody.top_p = body.top_p;
  }
  if (Array.isArray(body.tools)) {
    transformedBody.tools = convertResponsesToolsToChatTools(body.tools);
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
      ...request,
      path: '/v1/chat/completions',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: encodeJson(transformedBody),
    },
    streamRequested,
    requestedModel,
  };
}

export function transformOpenAIChatResponseToOpenAIResponses(
  response: SerializedHttpResponse,
  options: { fallbackModel?: string | null },
): SerializedHttpResponse {
  const parsed = parseJsonObject(response.body);
  if (!parsed) {
    return response;
  }

  if (response.statusCode >= 400) {
    return response;
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as Record<string, unknown>)
    : null;
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? (firstChoice.message as Record<string, unknown>)
    : null;

  const outputItems: unknown[] = [];
  const textContent = toStringContent(message?.content);
  if (textContent.length > 0) {
    outputItems.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: textContent }],
    });
  }

  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const toolCallRaw of toolCalls) {
    if (!toolCallRaw || typeof toolCallRaw !== 'object') {
      continue;
    }
    const toolCall = toolCallRaw as Record<string, unknown>;
    const functionPayload = toolCall.function && typeof toolCall.function === 'object'
      ? (toolCall.function as Record<string, unknown>)
      : {};
    const callId = typeof toolCall.id === 'string' ? toolCall.id : '';
    outputItems.push({
      type: 'function_call',
      id: callId,
      call_id: callId,
      name: typeof functionPayload.name === 'string' ? functionPayload.name : '',
      arguments: typeof functionPayload.arguments === 'string' ? functionPayload.arguments : '{}',
    });
  }

  const usage = parsed.usage && typeof parsed.usage === 'object'
    ? (parsed.usage as Record<string, unknown>)
    : {};
  const inputTokens = toNonNegativeInt(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens);

  const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : `resp_${response.requestId}`;
  const model = typeof parsed.model === 'string' && parsed.model.length > 0
    ? parsed.model
    : (options.fallbackModel ?? 'unknown');

  const responsesBody = {
    id,
    object: 'response',
    model,
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    output: outputItems,
    output_text: textContent,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  return {
    ...response,
    headers: { ...response.headers, 'content-type': 'application/json' },
    body: encodeJson(responsesBody),
  };
}
