import {
  createChatStreamParser,
  encodeSseEvents,
  makeStreamingStartResponse,
  parseSseBuffer,
  type StreamingResponseAdapter,
} from './utils.js';
import type { StreamAdapterRegistrar } from './stream-transform.js';

function createResponsesStreamAdapterFromChat(
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

function createChatStreamAdapterFromResponses(
  options: { fallbackModel?: string | null },
): StreamingResponseAdapter {
  let sseBuffer = '';
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';
  const toolNames = new Map<number, string>();
  const toolOutputIndexes = new Map<number, number>();
  const emitted: Array<{ data: string }> = [];
  const createdTimestamp = Math.floor(Date.now() / 1000);

  const pushChatChunk = (delta: Record<string, unknown>, finishReason?: string | null, usage?: Record<string, unknown>): void => {
    const chunk: Record<string, unknown> = {
      id: responseId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk', model: responseModel,
      created: createdTimestamp,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) chunk.usage = usage;
    emitted.push({ data: `data: ${JSON.stringify(chunk)}\n\n` });
  };

  return {
    adaptStart: makeStreamingStartResponse,
    adaptChunk(chunk) {
      emitted.length = 0;
      const text = new TextDecoder().decode(chunk.data);
      sseBuffer += text;
      const { events, remainder } = parseSseBuffer(sseBuffer);
      sseBuffer = remainder;

      for (const ev of events) {
        if (ev.data === '[DONE]') {
          emitted.push({ data: 'data: [DONE]\n\n' });
          continue;
        }
        let data: Record<string, unknown>;
        try { data = JSON.parse(ev.data) as Record<string, unknown>; }
        catch { continue; }

        const type = typeof data.type === 'string' ? data.type : '';

        if (type === 'response.created') {
          const resp = data.response as Record<string, unknown> | undefined;
          if (resp) {
            if (typeof resp.id === 'string') responseId = resp.id;
            if (typeof resp.model === 'string') responseModel = resp.model;
          }
          pushChatChunk({ role: 'assistant', content: '' });
          continue;
        }

        if (type === 'response.output_text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          pushChatChunk({ content: delta });
          continue;
        }

        if (type === 'response.output_item.added') {
          const item = data.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call') {
            const outputIndex = typeof data.output_index === 'number' ? data.output_index : 0;
            const toolIndex = toolOutputIndexes.get(outputIndex) ?? toolOutputIndexes.size;
            toolOutputIndexes.set(outputIndex, toolIndex);
            const name = typeof item.name === 'string' ? item.name : '';
            toolNames.set(toolIndex, name);
            const rawCallId = typeof item.call_id === 'string' ? item.call_id : '';
            const chatCallId = rawCallId.startsWith('fc_') ? rawCallId.slice(3) : rawCallId;
            pushChatChunk({
              tool_calls: [{
                index: toolIndex, id: chatCallId,
                type: 'function', function: { name, arguments: '' },
              }],
            });
          }
          continue;
        }

        if (type === 'response.function_call_arguments.delta') {
          const outputIndex = typeof data.output_index === 'number' ? data.output_index : 0;
          const toolIndex = toolOutputIndexes.get(outputIndex) ?? toolOutputIndexes.size;
          toolOutputIndexes.set(outputIndex, toolIndex);
          const argDelta = typeof data.delta === 'string' ? data.delta : '';
          pushChatChunk({
            tool_calls: [{ index: toolIndex, function: { arguments: argDelta } }],
          });
          continue;
        }

        if (type === 'response.completed') {
          const resp = data.response as Record<string, unknown> | undefined;
          const hasToolCalls = toolNames.size > 0;
          const usage = resp?.usage as Record<string, unknown> | undefined;
          const promptTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
          const completionTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
          const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens;
          pushChatChunk({}, hasToolCalls ? 'tool_calls' : 'stop', usage ? {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
          } : undefined);
          // Don't emit [DONE] here — the API sends a separate [DONE] sentinel
          // which the handler at the top of the loop will forward.
          continue;
        }
      }

      if (emitted.length > 0) {
        const combined = emitted.map((e) => e.data).join('');
        return [{ requestId: chunk.requestId, data: new TextEncoder().encode(combined), done: chunk.done }];
      }
      if (chunk.done) {
        return [{ requestId: chunk.requestId, data: new Uint8Array(0), done: true }];
      }
      return [];
    },
  };
}

export function registerOpenAIResponsesStreamingAdapters(register: StreamAdapterRegistrar): void {
  register('openai-chat-completions', 'openai-responses', createResponsesStreamAdapterFromChat);
  register('openai-responses', 'openai-chat-completions', createChatStreamAdapterFromResponses);
}
