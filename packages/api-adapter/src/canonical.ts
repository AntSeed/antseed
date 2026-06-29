import {
  extractUsage,
  mapFinishReasonToAnthropicStopReason,
  parseJsonSafe,
  toStringContent,
} from './utils.js';

export interface CanonicalFunctionTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type CanonicalToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string };

export type CanonicalInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; text: string }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> | string }
  | { type: 'function_call_output'; callId: string; output: string };

export interface CanonicalLlmRequest {
  model: string | null;
  stream: boolean;
  instructions?: string;
  input: CanonicalInputItem[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: CanonicalFunctionTool[];
  toolChoice?: CanonicalToolChoice;
  metadata?: Record<string, unknown>;
  user?: string;
}

export type CanonicalOutputItem =
  | { type: 'text'; text: string }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> | string };

export interface CanonicalLlmResponse {
  id: string;
  model: string;
  output: CanonicalOutputItem[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

function responseFunctionCallId(id: string): string {
  return id.startsWith('fc_') ? id : `fc_${id}`;
}

function chatFunctionCallId(id: string): string {
  return id.startsWith('fc_') ? id.slice(3) : id;
}

function toolParameters(parameters: unknown): Record<string, unknown> {
  return parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? parameters as Record<string, unknown>
    : { type: 'object', properties: {} };
}

export function renderCanonicalRequestToOpenAIChatBody(
  request: CanonicalLlmRequest,
  options: { toolCallContent?: '' | null; groupAssistantToolCallsWithPreviousMessage?: boolean } = {},
): Record<string, unknown> {
  const messages: unknown[] = [];
  if (request.instructions !== undefined && request.instructions.length > 0) {
    messages.push({ role: 'system', content: request.instructions });
  }

  for (const item of request.input) {
    if (item.type === 'message') {
      if (options.groupAssistantToolCallsWithPreviousMessage && item.role === 'assistant') {
        const previous = messages[messages.length - 1];
        if (isAssistantMessageWithToolCalls(previous)) {
          const existingContent = typeof previous.content === 'string' ? previous.content : '';
          previous.content = existingContent.length > 0 ? `${existingContent}\n${item.text}` : item.text;
          continue;
        }
      }
      messages.push({ role: item.role, content: item.text });
      continue;
    }
    if (item.type === 'function_call') {
      const toolCall = {
        id: item.id,
        type: 'function',
        function: { name: item.name, arguments: stringifyToolArguments(item.arguments) },
      };
      if (options.groupAssistantToolCallsWithPreviousMessage) {
        const previous = messages[messages.length - 1];
        if (isAssistantMessage(previous)) {
          const toolCalls = Array.isArray(previous.tool_calls) ? previous.tool_calls : [];
          previous.tool_calls = [...toolCalls, toolCall];
          continue;
        }
      }
      messages.push({
        role: 'assistant',
        content: options.toolCallContent !== undefined ? options.toolCallContent : '',
        tool_calls: [toolCall],
      });
      continue;
    }
    messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
  }

  const body: Record<string, unknown> = {
    ...(request.model ? { model: request.model } : {}),
    messages,
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
  };
  if (typeof request.maxOutputTokens === 'number') body.max_tokens = request.maxOutputTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.topP === 'number') body.top_p = request.topP;
  if (request.stop !== undefined) body.stop = request.stop;
  const tools = renderCanonicalToolsToOpenAIChat(request.tools);
  if (tools) body.tools = tools;
  const toolChoice = renderCanonicalToolChoiceToOpenAIChat(request.toolChoice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (request.metadata) body.metadata = request.metadata;
  if (request.user) body.user = request.user;
  return body;
}

export function renderCanonicalRequestToOpenAIResponsesBody(request: CanonicalLlmRequest): Record<string, unknown> {
  const input: unknown[] = [];

  for (const item of request.input) {
    if (item.type === 'message') {
      input.push({
        type: 'message',
        role: item.role,
        content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.text }],
      });
      continue;
    }
    if (item.type === 'function_call') {
      const id = responseFunctionCallId(item.id);
      input.push({
        type: 'function_call',
        id,
        call_id: id,
        name: item.name,
        arguments: stringifyToolArguments(item.arguments),
      });
      continue;
    }
    input.push({
      type: 'function_call_output',
      call_id: responseFunctionCallId(item.callId),
      output: item.output,
    });
  }

  const body: Record<string, unknown> = {
    ...(request.model ? { model: request.model } : {}),
    input,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    stream: request.stream,
  };
  if (typeof request.maxOutputTokens === 'number') body.max_output_tokens = request.maxOutputTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.topP === 'number') body.top_p = request.topP;
  if (request.stop !== undefined) body.stop = request.stop;
  const tools = renderCanonicalToolsToOpenAIResponses(request.tools);
  if (tools) body.tools = tools;
  const toolChoice = renderCanonicalToolChoiceToOpenAIResponses(request.toolChoice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (request.metadata) body.metadata = request.metadata;
  if (request.user) body.user = request.user;
  return body;
}

export function renderCanonicalRequestToAnthropicMessagesBody(request: CanonicalLlmRequest): Record<string, unknown> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];

  const appendBlock = (role: 'user' | 'assistant', block: Record<string, unknown>): void => {
    const previous = messages[messages.length - 1];
    if (previous?.role === role) {
      previous.content.push(block);
      return;
    }
    messages.push({ role, content: [block] });
  };

  for (const item of request.input) {
    if (item.type === 'message') {
      appendBlock(item.role, { type: 'text', text: item.text });
      continue;
    }
    if (item.type === 'function_call') {
      appendBlock('assistant', {
        type: 'tool_use',
        id: item.id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
      continue;
    }
    appendBlock('user', {
      type: 'tool_result',
      tool_use_id: item.callId,
      content: item.output,
    });
  }

  const body: Record<string, unknown> = {
    ...(request.model ? { model: request.model } : {}),
    messages,
    stream: request.stream,
  };
  if (request.instructions !== undefined) body.system = request.instructions;
  if (typeof request.maxOutputTokens === 'number') body.max_tokens = request.maxOutputTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.topP === 'number') body.top_p = request.topP;
  if (request.stop !== undefined) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  const tools = renderCanonicalToolsToAnthropic(request.tools);
  if (tools) body.tools = tools;
  const toolChoice = renderCanonicalToolChoiceToAnthropic(request.toolChoice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (request.metadata) body.metadata = request.metadata;
  if (request.user) body.user = request.user;
  return body;
}

export function normalizeAnthropicMessagesRequestBody(body: Record<string, unknown>): CanonicalLlmRequest {
  const request: CanonicalLlmRequest = {
    model: modelFromBody(body),
    stream: body.stream === true,
    input: [],
  };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const message = rawMessage as Record<string, unknown>;
    const role = message.role === 'assistant' ? 'assistant' : 'user';

    if (Array.isArray(message.content)) {
      appendAnthropicContentBlocks(request.input, role, message.content);
      continue;
    }

    const text = toStringContent(message.content);
    if (text.length > 0) {
      request.input.push({ type: 'message', role, text });
    }
  }

  const instructions = body.system !== undefined ? toStringContent(body.system) : '';
  if (instructions.length > 0) request.instructions = instructions;
  if (typeof body.max_tokens === 'number') request.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.topP = body.top_p;
  if (Array.isArray(body.stop_sequences)) request.stop = body.stop_sequences as string[];
  const tools = normalizeAnthropicTools(body.tools);
  if (tools) request.tools = tools;
  const toolChoice = normalizeAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.toolChoice = toolChoice;
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    request.metadata = body.metadata as Record<string, unknown>;
  }
  if (typeof body.user === 'string') request.user = body.user;
  return request;
}

export function normalizeOpenAIChatRequestBody(body: Record<string, unknown>): CanonicalLlmRequest {
  const request: CanonicalLlmRequest = {
    model: typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null,
    stream: body.stream === true,
    input: [],
  };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role : '';

    if (role === 'system') {
      const text = textFromContent(msg.content);
      if (text.length > 0) {
        request.instructions = request.instructions !== undefined ? `${request.instructions}\n\n${text}` : text;
      }
      continue;
    }

    if (role === 'tool') {
      const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      request.input.push({
        type: 'function_call_output',
        callId,
        output: textFromContent(msg.content),
      });
      continue;
    }

    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const text = textFromContent(msg.content);
      if (text.length > 0) request.input.push({ type: 'message', role: 'assistant', text });
      for (const [index, rawToolCall] of (msg.tool_calls as unknown[]).entries()) {
        if (!rawToolCall || typeof rawToolCall !== 'object') continue;
        const toolCall = rawToolCall as Record<string, unknown>;
        const fn = toolCall.function && typeof toolCall.function === 'object'
          ? toolCall.function as Record<string, unknown>
          : {};
        request.input.push({
          type: 'function_call',
          id: typeof toolCall.id === 'string' && toolCall.id.length > 0 ? toolCall.id : `call_${index + 1}`,
          name: typeof fn.name === 'string' ? fn.name : '',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }

    if (role === 'user' || role === 'assistant') {
      request.input.push({ type: 'message', role, text: textFromContent(msg.content) });
    }
  }

  if (typeof body.max_tokens === 'number') request.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.topP = body.top_p;
  if (typeof body.stop === 'string' || Array.isArray(body.stop)) request.stop = body.stop as string | string[];
  if (Array.isArray(body.tools)) request.tools = normalizeChatTools(body.tools);
  const toolChoice = normalizeChatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.toolChoice = toolChoice;
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    request.metadata = body.metadata as Record<string, unknown>;
  }
  if (typeof body.user === 'string') request.user = body.user;
  return request;
}

export function normalizeOpenAIResponsesRequestBody(body: Record<string, unknown>): CanonicalLlmRequest {
  const request: CanonicalLlmRequest = {
    model: typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null,
    stream: body.stream === true,
    input: [],
  };
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    request.instructions = body.instructions;
  }

  const input = body.input;
  if (typeof input === 'string') {
    request.input.push({ type: 'message', role: 'user', text: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const msg = item as Record<string, unknown>;
      const type = typeof msg.type === 'string' ? msg.type : '';

      if (type === 'function_call_output') {
        request.input.push({
          type: 'function_call_output',
          callId: typeof msg.call_id === 'string' ? msg.call_id : '',
          output: typeof msg.output === 'string' ? msg.output : '',
        });
        continue;
      }

      if (type === 'function_call') {
        request.input.push({
          type: 'function_call',
          id: typeof msg.call_id === 'string' && msg.call_id.length > 0
            ? msg.call_id : (typeof msg.id === 'string' ? msg.id : ''),
          name: typeof msg.name === 'string' ? msg.name : '',
          arguments: typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? {}),
        });
        continue;
      }

      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      request.input.push({ type: 'message', role, text: textFromResponsesContent(msg.content) });
    }
  }

  if (typeof body.max_output_tokens === 'number') request.maxOutputTokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.topP = body.top_p;
  if (typeof body.stop === 'string' || Array.isArray(body.stop)) request.stop = body.stop as string | string[];
  if (Array.isArray(body.tools)) request.tools = normalizeResponsesTools(body.tools);
  const toolChoice = normalizeResponsesToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.toolChoice = toolChoice;
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    request.metadata = body.metadata as Record<string, unknown>;
  }
  if (typeof body.user === 'string') request.user = body.user;
  return request;
}

export function normalizeOpenAIChatResponseBody(
  body: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): CanonicalLlmResponse {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : fallbacks.id;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbacks.model;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object'
    ? choices[0] as Record<string, unknown>
    : {};
  const message = firstChoice.message && typeof firstChoice.message === 'object'
    ? firstChoice.message as Record<string, unknown>
    : {};

  const output: CanonicalOutputItem[] = [];
  const text = toStringContent(message.content);
  if (text.length > 0) output.push({ type: 'text', text });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const [index, rawToolCall] of toolCalls.entries()) {
    if (!rawToolCall || typeof rawToolCall !== 'object') continue;
    const toolCall = rawToolCall as Record<string, unknown>;
    const fn = toolCall.function && typeof toolCall.function === 'object'
      ? toolCall.function as Record<string, unknown>
      : {};
    output.push({
      type: 'function_call',
      id: typeof toolCall.id === 'string' && toolCall.id.length > 0 ? toolCall.id : `call_${index + 1}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }

  const { inputTokens, outputTokens } = extractUsage(body);
  const stopReason = typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : null;
  return { id, model, output, stopReason, usage: { inputTokens, outputTokens } };
}

export function normalizeOpenAIResponsesResponseBody(
  body: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): CanonicalLlmResponse {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : fallbacks.id;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbacks.model;
  const output: CanonicalOutputItem[] = [];

  const items = Array.isArray(body.output) ? body.output : [];
  for (const itemRaw of items) {
    if (!itemRaw || typeof itemRaw !== 'object') continue;
    const item = itemRaw as Record<string, unknown>;
    if (item.type === 'message') {
      const text = textFromResponsesContent(item.content);
      if (text.length > 0) output.push({ type: 'text', text });
      continue;
    }
    if (item.type === 'function_call') {
      const idValue = typeof item.call_id === 'string' && item.call_id.length > 0
        ? item.call_id
        : (typeof item.id === 'string' ? item.id : '');
      output.push({
        type: 'function_call',
        id: chatFunctionCallId(idValue),
        name: typeof item.name === 'string' ? item.name : '',
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
    }
  }

  const { inputTokens, outputTokens } = extractUsage(body);
  const stopReason = output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop';
  return { id, model, output, stopReason, usage: { inputTokens, outputTokens } };
}

export function normalizeAnthropicMessagesResponseBody(
  body: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): CanonicalLlmResponse {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : fallbacks.id;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbacks.model;
  const output: CanonicalOutputItem[] = [];

  const content = Array.isArray(body.content) ? body.content : [];
  for (const blockRaw of content) {
    if (!blockRaw || typeof blockRaw !== 'object') continue;
    const block = blockRaw as Record<string, unknown>;
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.length > 0) output.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        arguments: block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input as Record<string, unknown>
          : {},
      });
    }
  }

  const { inputTokens, outputTokens } = extractUsage(body);
  const stopReason = anthropicStopReasonToOpenAI(body.stop_reason);
  return { id, model, output, stopReason, usage: { inputTokens, outputTokens } };
}

export function renderCanonicalResponseToOpenAIChatBody(response: CanonicalLlmResponse): Record<string, unknown> {
  const text = response.output
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('');
  const toolCalls = response.output
    .filter((item): item is Extract<CanonicalOutputItem, { type: 'function_call' }> => item.type === 'function_call')
    .map((item) => ({
      id: chatFunctionCallId(item.id),
      type: 'function',
      function: { name: item.name, arguments: stringifyToolArguments(item.arguments) },
    }));

  return {
    id: response.id,
    object: 'chat.completion',
    model: response.model,
    created: Math.floor(Date.now() / 1000),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: response.stopReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
  };
}

export function renderCanonicalResponseToOpenAIResponsesBody(response: CanonicalLlmResponse): Record<string, unknown> {
  const output: unknown[] = [];
  const text = response.output
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('');

  if (text.length > 0) {
    output.push({
      type: 'message',
      id: `${response.id}_msg_1`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const item of response.output) {
    if (item.type !== 'function_call') continue;
    output.push({
      type: 'function_call',
      id: item.id,
      call_id: item.id,
      name: item.name,
      arguments: stringifyToolArguments(item.arguments),
      status: 'completed',
    });
  }

  return {
    id: response.id,
    object: 'response',
    model: response.model,
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    output,
    output_text: text,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
  };
}

export function renderCanonicalResponseToAnthropicMessagesBody(response: CanonicalLlmResponse): Record<string, unknown> {
  const content = response.output.map((item) => {
    if (item.type === 'text') return { type: 'text', text: item.text };
    return {
      type: 'tool_use',
      id: item.id,
      name: item.name || 'tool',
      input: parseToolArguments(item.arguments),
    };
  });

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: mapFinishReasonToAnthropicStopReason(response.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    },
  };
}

function stringifyToolArguments(args: Record<string, unknown> | string): string {
  return typeof args === 'string' ? args : JSON.stringify(args);
}

function parseToolArguments(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args !== 'string') return args;
  const parsed = parseJsonSafe(args);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { raw: args };
}

function modelFromBody(body: Record<string, unknown>): string | null {
  return typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
    && (value as Record<string, unknown>).role === 'assistant';
}

function isAssistantMessageWithToolCalls(value: unknown): value is Record<string, unknown> {
  return isAssistantMessage(value) && Array.isArray(value.tool_calls);
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
      .map((part) => {
        if (typeof part.text === 'string') return part.text;
        if (typeof part.refusal === 'string') return part.refusal;
        if (part.type === 'tool_result') return textFromContent(part.content);
        return '';
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }
  if (typeof value === 'object') {
    const part = value as Record<string, unknown>;
    if (typeof part.text === 'string') return part.text;
    if (typeof part.refusal === 'string') return part.refusal;
  }
  return String(value);
}

function textFromResponsesContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter((text) => text.length > 0)
    .join('\n');
}

function appendAnthropicContentBlocks(
  input: CanonicalInputItem[],
  role: 'user' | 'assistant',
  blocks: unknown[],
): void {
  const textParts: string[] = [];
  const flushText = (): void => {
    if (textParts.length === 0) return;
    input.push({ type: 'message', role, text: textParts.join('\n') });
    textParts.length = 0;
  };

  for (const blockRaw of blocks) {
    if (!blockRaw || typeof blockRaw !== 'object') continue;
    const block = blockRaw as Record<string, unknown>;

    if (role === 'assistant' && block.type === 'tool_use') {
      flushText();
      input.push({
        type: 'function_call',
        id: typeof block.id === 'string' && block.id.length > 0 ? block.id : `call_${input.length + 1}`,
        name: typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool',
        arguments: block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input as Record<string, unknown>
          : {},
      });
      continue;
    }

    if (role === 'user' && block.type === 'tool_result') {
      flushText();
      const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (callId.length > 0) {
        input.push({ type: 'function_call_output', callId, output: toStringContent(block.content) });
      }
      continue;
    }

    const text = toStringContent(block);
    if (text.length > 0) textParts.push(text);
  }

  flushText();
}

function normalizeAnthropicTools(toolsRaw: unknown): CanonicalFunctionTool[] | undefined {
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) return undefined;
  const out: CanonicalFunctionTool[] = [];
  for (const toolRaw of toolsRaw) {
    if (!toolRaw || typeof toolRaw !== 'object') continue;
    const tool = toolRaw as Record<string, unknown>;
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
    const entry: CanonicalFunctionTool = {
      name: tool.name,
      parameters: toolParameters(tool.input_schema),
    };
    if (typeof tool.description === 'string' && tool.description.length > 0) entry.description = tool.description;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeChatTools(tools: unknown[]): CanonicalFunctionTool[] | undefined {
  const out: CanonicalFunctionTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = raw as Record<string, unknown>;
    if (tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') continue;
    const fn = tool.function as Record<string, unknown>;
    if (typeof fn.name !== 'string' || fn.name.length === 0) continue;
    const entry: CanonicalFunctionTool = { name: fn.name, parameters: toolParameters(fn.parameters) };
    if (typeof fn.description === 'string' && fn.description.length > 0) entry.description = fn.description;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeResponsesTools(tools: unknown[]): CanonicalFunctionTool[] | undefined {
  const out: CanonicalFunctionTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = raw as Record<string, unknown>;
    if (tool.type !== 'function' || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    const entry: CanonicalFunctionTool = { name: tool.name, parameters: toolParameters(tool.parameters) };
    if (typeof tool.description === 'string' && tool.description.length > 0) entry.description = tool.description;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function renderCanonicalToolsToAnthropic(tools: CanonicalFunctionTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }));
}

function renderCanonicalToolsToOpenAIChat(tools: CanonicalFunctionTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

function renderCanonicalToolsToOpenAIResponses(tools: CanonicalFunctionTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  }));
}

function normalizeAnthropicToolChoice(toolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return undefined;
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name.length > 0) {
    return { type: 'function', name: choice.name };
  }
  return undefined;
}

function normalizeChatToolChoice(toolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return undefined;
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === 'function' && choice.function && typeof choice.function === 'object') {
    const fn = choice.function as Record<string, unknown>;
    if (typeof fn.name === 'string') return { type: 'function', name: fn.name };
  }
  return undefined;
}

function normalizeResponsesToolChoice(toolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return undefined;
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', name: choice.name };
  }
  return undefined;
}

function renderCanonicalToolChoiceToAnthropic(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'auto' || toolChoice === 'none') return { type: toolChoice };
  if (toolChoice?.type === 'function') return { type: 'tool', name: toolChoice.name };
  return undefined;
}

function renderCanonicalToolChoiceToOpenAIChat(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice?.type === 'function') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return undefined;
}

function anthropicStopReasonToOpenAI(stopReason: unknown): string | null {
  if (typeof stopReason !== 'string' || stopReason.length === 0) return null;
  if (stopReason === 'end_turn') return 'stop';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return stopReason;
}

function renderCanonicalToolChoiceToOpenAIResponses(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice?.type === 'function') {
    return { type: 'function', name: toolChoice.name };
  }
  return undefined;
}
