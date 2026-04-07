import type { SerializedHttpResponse, SerializedHttpResponseChunk } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface StreamingResponseAdapter {
  adaptStart(response: SerializedHttpResponse): SerializedHttpResponse;
  adaptChunk(chunk: SerializedHttpResponseChunk): SerializedHttpResponseChunk[];
}

export interface ParsedSseEvent {
  event: string | null;
  data: string;
}

export function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(decoder.decode(body)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function toNonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export interface TokenUsage {
  /** Total input tokens (includes cached for OpenAI, fresh-only for Anthropic). */
  inputTokens: number;
  outputTokens: number;
  /** Fresh (non-cached) input tokens. Always independent of cachedInputTokens. */
  freshInputTokens: number;
  /** Cached input tokens (prompt cache hits). Independent count, never overlaps freshInputTokens. */
  cachedInputTokens: number;
}

export function extractUsage(parsed: Record<string, unknown>): TokenUsage {
  const usage = parsed.usage && typeof parsed.usage === 'object'
    ? (parsed.usage as Record<string, unknown>)
    : {};

  const totalInput = toNonNegativeInt(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens);

  // OpenAI/Together: prompt_tokens_details.cached_tokens (subset of prompt_tokens)
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? (usage.prompt_tokens_details as Record<string, unknown>)
    : {};
  const openaiCached = toNonNegativeInt(details.cached_tokens);

  // Anthropic: cache_read_input_tokens is separate from input_tokens (which is fresh-only)
  const anthropicCached = toNonNegativeInt(usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens);

  let freshInputTokens: number;
  let cachedInputTokens: number;

  if (anthropicCached > 0) {
    // Anthropic style: input_tokens is already fresh-only
    freshInputTokens = totalInput;
    cachedInputTokens = anthropicCached;
  } else if (openaiCached > 0) {
    // OpenAI style: prompt_tokens includes cached subset
    freshInputTokens = Math.max(0, totalInput - openaiCached);
    cachedInputTokens = openaiCached;
  } else {
    // No cache info — all tokens are fresh
    freshInputTokens = totalInput;
    cachedInputTokens = 0;
  }

  return { inputTokens: totalInput, outputTokens, freshInputTokens, cachedInputTokens };
}

function toStringContentBlock(block: Record<string, unknown>): string {
  if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'output_text' && typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'refusal' && typeof block.refusal === 'string') {
    return block.refusal;
  }
  if (block.type === 'tool_result') {
    return toStringContent(block.content);
  }
  return '';
}

export function toStringContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .map(toStringContentBlock)
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (typeof value === 'object') {
    return toStringContentBlock(value as Record<string, unknown>);
  }
  return String(value);
}

export function mapFinishReasonToAnthropicStopReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value === 'stop') return 'end_turn';
  if (value === 'length') return 'max_tokens';
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  return value;
}

export function parseSseBuffer(buffer: string): { events: ParsedSseEvent[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const events: ParsedSseEvent[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length));
      }
    }
    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') });
    }
  }

  return { events, remainder };
}

export function encodeSseEvents(events: Array<{ event?: string; data: unknown | string }>): Uint8Array {
  const chunks: string[] = [];
  for (const item of events) {
    if (item.event) {
      chunks.push(`event: ${item.event}\n`);
    }
    const data = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
    chunks.push(`data: ${data}\n\n`);
  }
  return encoder.encode(chunks.join(''));
}

export function makeStreamingStartResponse(response: SerializedHttpResponse): SerializedHttpResponse {
  return {
    ...response,
    headers: { ...response.headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: new Uint8Array(0),
  };
}

// ---------------------------------------------------------------------------
// Shared OpenAI Chat Completions parsing
// ---------------------------------------------------------------------------

export interface ParsedChatResponse {
  id: string;
  model: string;
  textContent: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

export function parseChatCompletionResponse(
  parsed: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): ParsedChatResponse {
  const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : fallbacks.id;
  const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : fallbacks.model;

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as Record<string, unknown>) : null;
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? (firstChoice.message as Record<string, unknown>) : null;

  const textContent = toStringContent(message?.content);

  const toolCalls: ParsedChatResponse['toolCalls'] = [];
  const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const [i, raw] of rawToolCalls.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const tc = raw as Record<string, unknown>;
    const fn = tc.function && typeof tc.function === 'object'
      ? (tc.function as Record<string, unknown>) : {};
    toolCalls.push({
      id: typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : `call_${i + 1}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
    });
  }

  const finishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : null;
  const { inputTokens, outputTokens } = extractUsage(parsed);

  return { id, model, textContent, toolCalls, finishReason, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Shared OpenAI Chat Completions stream parser
// ---------------------------------------------------------------------------

export interface ChatStreamFinishInfo {
  id: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
  toolCalls: Array<{ index: number; id: string; name: string; arguments: string }>;
}

export interface ChatStreamCallbacks {
  onText(delta: string): void;
  onToolCallStart(index: number, id: string, name: string): void;
  onToolCallDelta(index: number, id: string, argumentsDelta: string): void;
  onFinish(info: ChatStreamFinishInfo): void;
}

export interface ChatStreamParser {
  getId(): string;
  getModel(): string;
  feed(data: Uint8Array, done: boolean): void;
}

export function createChatStreamParser(
  callbacks: ChatStreamCallbacks,
  fallbacks?: { id?: string; model?: string },
): ChatStreamParser {
  let rawBuffer = '';
  const streamDecoder = new TextDecoder();
  let id = fallbacks?.id ?? '';
  let model = fallbacks?.model ?? 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  return {
    getId: () => id,
    getModel: () => model,
    feed(data, done) {
      if (data.length > 0) {
        rawBuffer += streamDecoder.decode(data, { stream: !done });
      }
      const { events, remainder } = parseSseBuffer(rawBuffer);
      rawBuffer = remainder;

      for (const event of events) {
        if (event.data === '[DONE]') continue;
        const parsed = parseJsonSafe(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const p = parsed as Record<string, unknown>;

        if (typeof p.id === 'string' && p.id.length > 0) id = p.id;
        if (typeof p.model === 'string' && p.model.length > 0) model = p.model;

        const usage = p.usage && typeof p.usage === 'object'
          ? p.usage as Record<string, unknown> : null;
        if (usage) {
          inputTokens = toNonNegativeInt(usage.prompt_tokens ?? usage.input_tokens);
          outputTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens);
        }

        const choices = Array.isArray(p.choices) ? p.choices : [];
        const firstChoice = choices[0] && typeof choices[0] === 'object'
          ? choices[0] as Record<string, unknown> : null;
        const delta = firstChoice?.delta && typeof firstChoice.delta === 'object'
          ? firstChoice.delta as Record<string, unknown> : null;

        if (typeof firstChoice?.finish_reason === 'string' && firstChoice.finish_reason.length > 0) {
          finishReason = firstChoice.finish_reason;
        }

        const textDelta = typeof delta?.content === 'string' ? delta.content : '';
        if (textDelta.length > 0) {
          callbacks.onText(textDelta);
        }

        const deltaToolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
        for (const tcRaw of deltaToolCalls) {
          if (!tcRaw || typeof tcRaw !== 'object') continue;
          const tc = tcRaw as Record<string, unknown>;
          const rawIdx = typeof tc.index === 'number' ? tc.index : 0;
          const idx = Number.isFinite(rawIdx) ? Math.max(0, Math.floor(rawIdx)) : 0;
          const fn = tc.function && typeof tc.function === 'object'
            ? tc.function as Record<string, unknown> : {};
          const existing = toolCalls.get(idx);
          const tcId = typeof tc.id === 'string' && tc.id.length > 0
            ? tc.id : (existing?.id ?? '');
          const tcName = typeof fn.name === 'string' && fn.name.length > 0
            ? fn.name : (existing?.name ?? '');
          const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';

          if (!existing) {
            callbacks.onToolCallStart(idx, tcId, tcName);
          }

          toolCalls.set(idx, {
            id: tcId,
            name: tcName,
            arguments: (existing?.arguments ?? '') + argsDelta,
          });

          if (argsDelta.length > 0) {
            callbacks.onToolCallDelta(idx, tcId, argsDelta);
          }
        }
      }

      if (done) {
        const sorted = [...toolCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, tc]) => ({ index, ...tc }));
        callbacks.onFinish({ id, model, inputTokens, outputTokens, finishReason, toolCalls: sorted });
      }
    },
  };
}
