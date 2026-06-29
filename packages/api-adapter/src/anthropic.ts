import type { StreamAdapterRegistrar } from './stream-transform.js';
import {
  createChatStreamParser,
  encodeText,
  encodeSseEvents,
  makeStreamingStartResponse,
  mapFinishReasonToAnthropicStopReason,
  parseJsonSafe,
  parseSseBuffer,
  type StreamingResponseAdapter,
} from './utils.js';

export function stripAnthropicHeaders(headers: Record<string, string>): Record<string, string> {
  const transformedHeaders: Record<string, string> = { ...headers };
  for (const headerName of Object.keys(transformedHeaders)) {
    const lower = headerName.toLowerCase();
    if (lower === 'anthropic-version' || lower === 'anthropic-beta') delete transformedHeaders[headerName];
  }
  transformedHeaders['content-type'] = 'application/json';
  return transformedHeaders;
}

function createAnthropicStreamAdapterFromChat(
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

function createChatStreamAdapterFromAnthropic(
  options: { fallbackModel?: string | null },
): StreamingResponseAdapter {
  let sseBuffer = '';
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  const toolBlockIndexes = new Map<number, number>();
  const emitted: Array<{ data: string }> = [];
  const createdTimestamp = Math.floor(Date.now() / 1000);

  const pushChatChunk = (
    delta: Record<string, unknown>,
    finishReason?: string | null,
    usage?: Record<string, unknown>,
  ): void => {
    const chunk: Record<string, unknown> = {
      id: responseId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      model: responseModel,
      created: createdTimestamp,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) chunk.usage = usage;
    emitted.push({ data: `data: ${JSON.stringify(chunk)}\n\n` });
  };

  const toolIndexForBlock = (blockIndex: number): number => {
    const existing = toolBlockIndexes.get(blockIndex);
    if (existing !== undefined) return existing;
    const next = toolBlockIndexes.size;
    toolBlockIndexes.set(blockIndex, next);
    return next;
  };

  return {
    adaptStart: makeStreamingStartResponse,
    adaptChunk(chunk) {
      emitted.length = 0;
      sseBuffer += new TextDecoder().decode(chunk.data);
      const { events, remainder } = parseSseBuffer(sseBuffer);
      sseBuffer = remainder;

      for (const event of events) {
        if (event.data === '[DONE]') continue;
        const parsed = parseJsonSafe(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const data = parsed as Record<string, unknown>;
        const type = typeof data.type === 'string' ? data.type : event.event;

        if (type === 'message_start') {
          const message = data.message && typeof data.message === 'object'
            ? data.message as Record<string, unknown>
            : {};
          if (typeof message.id === 'string') responseId = message.id;
          if (typeof message.model === 'string') responseModel = message.model;
          const usage = message.usage && typeof message.usage === 'object'
            ? message.usage as Record<string, unknown>
            : {};
          inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          pushChatChunk({ role: 'assistant', content: '' });
          continue;
        }

        if (type === 'content_block_start') {
          const block = data.content_block && typeof data.content_block === 'object'
            ? data.content_block as Record<string, unknown>
            : {};
          if (block.type === 'tool_use') {
            const blockIndex = typeof data.index === 'number' ? data.index : 0;
            const toolIndex = toolIndexForBlock(blockIndex);
            const id = typeof block.id === 'string' ? block.id : `call_${toolIndex + 1}`;
            const name = typeof block.name === 'string' ? block.name : 'tool';
            pushChatChunk({
              tool_calls: [{
                index: toolIndex,
                id,
                type: 'function',
                function: { name, arguments: '' },
              }],
            });
          }
          continue;
        }

        if (type === 'content_block_delta') {
          const delta = data.delta && typeof data.delta === 'object'
            ? data.delta as Record<string, unknown>
            : {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            pushChatChunk({ content: delta.text });
            continue;
          }
          if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const blockIndex = typeof data.index === 'number' ? data.index : 0;
            pushChatChunk({
              tool_calls: [{
                index: toolIndexForBlock(blockIndex),
                function: { arguments: delta.partial_json },
              }],
            });
          }
          continue;
        }

        if (type === 'message_delta') {
          const delta = data.delta && typeof data.delta === 'object'
            ? data.delta as Record<string, unknown>
            : {};
          stopReason = anthropicStopReasonToOpenAI(delta.stop_reason);
          const usage = data.usage && typeof data.usage === 'object'
            ? data.usage as Record<string, unknown>
            : {};
          outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : outputTokens;
          continue;
        }

        if (type === 'message_stop') {
          pushChatChunk({}, stopReason ?? 'stop', {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          });
          emitted.push({ data: 'data: [DONE]\n\n' });
        }
      }

      if (emitted.length > 0) {
        return [{ requestId: chunk.requestId, data: encodeText(emitted.map((item) => item.data).join('')), done: chunk.done }];
      }
      if (chunk.done) {
        return [{ requestId: chunk.requestId, data: new Uint8Array(0), done: true }];
      }
      return [];
    },
  };
}

export function registerAnthropicStreamingAdapters(register: StreamAdapterRegistrar): void {
  register('openai-chat-completions', 'anthropic-messages', createAnthropicStreamAdapterFromChat);
  register('anthropic-messages', 'openai-chat-completions', createChatStreamAdapterFromAnthropic);
}

function anthropicStopReasonToOpenAI(stopReason: unknown): string | null {
  if (typeof stopReason !== 'string' || stopReason.length === 0) return null;
  if (stopReason === 'end_turn') return 'stop';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return stopReason;
}
