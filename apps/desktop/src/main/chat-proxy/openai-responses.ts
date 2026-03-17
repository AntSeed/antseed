import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type { AssistantMessage, Context, Message, Model, StreamOptions, Tool, ToolResultMessage } from '@mariozechner/pi-ai';

import { convertToolContentToText, ensureUsageShape, parseProxyMeta, parseToolJson, toUsage, type AiMessageMeta } from './common.js';

type PendingToolState = {
  callId: string;
  name: string;
  argumentsText: string;
};

function responsesContentFromUser(content: Extract<Message, { role: 'user' }>['content']): unknown {
  if (typeof content === 'string') return content;
  const parts: unknown[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (text.length > 0) parts.push({ type: 'input_text', text });
      continue;
    }
    parts.push({
      type: 'input_image',
      image_url: `data:${block.mimeType};base64,${block.data}`,
    });
  }
  return parts;
}

function convertContextMessagesToResponses(messages: Message[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      const content = responsesContentFromUser(message.content);
      if (typeof content === 'string' && content.length === 0) continue;
      if (Array.isArray(content) && content.length === 0) continue;
      converted.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant') {
      let textContent = '';
      const functionCalls: Array<Record<string, unknown>> = [];
      for (const block of message.content) {
        if (!block) continue;
        if (block.type === 'text') {
          textContent += block.text ?? '';
          continue;
        }
        if (block.type === 'thinking') continue;
        if (block.type === 'toolCall') {
          functionCalls.push({
            type: 'function_call',
            id: block.id,
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments ?? {}),
          });
        }
      }
      if (textContent.length > 0) converted.push({ role: 'assistant', content: textContent });
      if (functionCalls.length > 0) {
        const nextMessage = messages[index + 1];
        if (nextMessage && nextMessage.role === 'toolResult') {
          converted.push(...functionCalls);
        }
      }
      continue;
    }
    if (message.role === 'toolResult') {
      let toolIndex = index;
      while (toolIndex < messages.length) {
        const toolMessage = messages[toolIndex];
        if (!toolMessage || toolMessage.role !== 'toolResult') break;
        const toolResult = toolMessage as ToolResultMessage;
        converted.push({
          type: 'function_call_output',
          call_id: toolResult.toolCallId,
          output: convertToolContentToText(toolResult.content) || '(no tool output)',
        });
        toolIndex += 1;
      }
      index = toolIndex - 1;
    }
  }
  return converted;
}

function convertToolsToResponses(tools?: Tool[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function extractResponseOutputText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => String(part.text ?? ''))
    .join('');
}

export function createBuyerProxyResponsesStreamFn(
  onMeta: (meta: AiMessageMeta) => void,
  providerHint: string | null,
  preferredPeerId: string | null,
  totalTimeoutMs: number,
  idleTimeoutMs: number,
): (model: Model<any>, context: Context, options?: StreamOptions) => ReturnType<typeof createAssistantMessageEventStream> {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const timeoutController = new AbortController();
    const parentSignal = options?.signal;
    let timeoutErrorMessage: string | null = null;
    let totalTimeout: ReturnType<typeof setTimeout> | null = null;
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimeout = (): void => { if (idleTimeout) clearTimeout(idleTimeout); idleTimeout = null; };
    const clearTotalTimeout = (): void => { if (totalTimeout) clearTimeout(totalTimeout); totalTimeout = null; };
    const triggerTimeoutAbort = (msg: string): void => {
      if (timeoutController.signal.aborted) return;
      timeoutErrorMessage = msg;
      timeoutController.abort();
    };
    const resetIdleTimeout = (): void => {
      clearIdleTimeout();
      idleTimeout = setTimeout(() => {
        triggerTimeoutAbort(`Proxy stream idle timeout after ${String(idleTimeoutMs)}ms`);
      }, idleTimeoutMs);
    };

    totalTimeout = setTimeout(() => {
      triggerTimeoutAbort(`Proxy stream timed out after ${String(totalTimeoutMs)}ms`);
    }, totalTimeoutMs);
    const onParentAbort = (): void => {
      if (!timeoutController.signal.aborted) timeoutController.abort();
    };
    if (parentSignal) {
      if (parentSignal.aborted) timeoutController.abort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    void (async () => {
      const startedAt = Date.now();
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: ensureUsageShape(),
        stopReason: 'stop',
        timestamp: Date.now(),
      };

      const requestBody: Record<string, unknown> = {
        model: model.id,
        input: convertContextMessagesToResponses(context.messages),
        stream: true,
      };
      if (context.systemPrompt) requestBody.instructions = context.systemPrompt;
      const tools = convertToolsToResponses(context.tools);
      if (tools) requestBody.tools = tools;

      let responseMeta: AiMessageMeta | undefined;
      const itemIdByOutputIndex = new Map<number, string>();
      const textBlockIndexByItemId = new Map<string, number>();
      const toolBlockIndexByItemId = new Map<string, number>();
      const toolJsonByBlockIndex = new Map<number, string>();
      const pendingToolStateByItemId = new Map<string, PendingToolState>();
      const finishedTextItemIds = new Set<string>();
      const finishedToolItemIds = new Set<string>();
      const blocks = message.content;

      const setUsage = (usageData: unknown): void => {
        const next = toUsage(usageData);
        if (next.input > 0) message.usage.input = next.input;
        if (next.output > 0) message.usage.output = next.output;
        if (next.cacheRead > 0) message.usage.cacheRead = next.cacheRead;
        if (next.cacheWrite > 0) message.usage.cacheWrite = next.cacheWrite;
        if (next.totalTokens > 0) message.usage.totalTokens = next.totalTokens;
      };

      const resolveItemId = (
        payload: Record<string, unknown>,
        item?: Record<string, unknown>,
      ): string => {
        const directItemId = typeof payload.item_id === 'string' && payload.item_id.trim().length > 0
          ? payload.item_id.trim()
          : '';
        if (directItemId.length > 0) return directItemId;

        const inlineItemId = typeof item?.id === 'string' && item.id.trim().length > 0
          ? item.id.trim()
          : '';
        if (inlineItemId.length > 0) {
          const outputIndex = Number(payload.output_index);
          if (Number.isInteger(outputIndex) && outputIndex >= 0) {
            itemIdByOutputIndex.set(outputIndex, inlineItemId);
          }
          return inlineItemId;
        }

        const outputIndex = Number(payload.output_index);
        if (Number.isInteger(outputIndex) && outputIndex >= 0) {
          const knownItemId = itemIdByOutputIndex.get(outputIndex);
          if (knownItemId) return knownItemId;
          const syntheticItemId = `output-index-${String(outputIndex)}`;
          itemIdByOutputIndex.set(outputIndex, syntheticItemId);
          return syntheticItemId;
        }

        return '';
      };

      const ensureToolState = (itemId: string): PendingToolState => {
        const existing = pendingToolStateByItemId.get(itemId);
        if (existing) return existing;
        const created: PendingToolState = { callId: '', name: '', argumentsText: '' };
        pendingToolStateByItemId.set(itemId, created);
        return created;
      };

      const appendTextDelta = (itemId: string, delta: string): void => {
        let blockIndex = textBlockIndexByItemId.get(itemId);
        if (blockIndex === undefined) {
          const textBlock = { type: 'text' as const, text: '' };
          blocks.push(textBlock);
          blockIndex = blocks.length - 1;
          textBlockIndexByItemId.set(itemId, blockIndex);
          stream.push({ type: 'text_start', contentIndex: blockIndex, partial: message });
        }
        const block = blocks[blockIndex];
        if (!block || block.type !== 'text' || delta.length === 0) return;
        block.text += delta;
        stream.push({ type: 'text_delta', contentIndex: blockIndex, delta, partial: message });
      };

      const finishTextItem = (itemId: string, finalText?: string): void => {
        if (finishedTextItemIds.has(itemId)) return;
        const blockIndex = textBlockIndexByItemId.get(itemId);
        if (blockIndex === undefined) return;
        const block = blocks[blockIndex];
        if (!block || block.type !== 'text') return;
        if (typeof finalText === 'string' && finalText.length >= block.text.length && finalText !== block.text) {
          const suffix = finalText.slice(block.text.length);
          if (suffix.length > 0) {
            block.text += suffix;
            stream.push({ type: 'text_delta', contentIndex: blockIndex, delta: suffix, partial: message });
          }
        }
        finishedTextItemIds.add(itemId);
        stream.push({ type: 'text_end', contentIndex: blockIndex, content: block.text, partial: message });
      };

      const ensureToolBlock = (itemId: string): number | null => {
        const existingIndex = toolBlockIndexByItemId.get(itemId);
        if (existingIndex !== undefined) return existingIndex;
        const state = ensureToolState(itemId);
        if (state.name.trim().length === 0) return null;
        const toolBlock = {
          type: 'toolCall' as const,
          id: state.callId || itemId,
          name: state.name,
          arguments: {} as Record<string, unknown>,
        };
        blocks.push(toolBlock);
        const blockIndex = blocks.length - 1;
        toolBlockIndexByItemId.set(itemId, blockIndex);
        toolJsonByBlockIndex.set(blockIndex, state.argumentsText);
        if (state.argumentsText.length > 0) {
          const parsed = parseToolJson(state.argumentsText);
          if (parsed) toolBlock.arguments = parsed;
        }
        stream.push({ type: 'toolcall_start', contentIndex: blockIndex, partial: message });
        if (state.argumentsText.length > 0) {
          stream.push({ type: 'toolcall_delta', contentIndex: blockIndex, delta: state.argumentsText, partial: message });
        }
        return blockIndex;
      };

      const appendToolDelta = (itemId: string, callId: string, name: string, delta: string): void => {
        const state = ensureToolState(itemId);
        if (callId) state.callId = callId;
        if (name) state.name = name;
        if (delta.length > 0) state.argumentsText += delta;
        const blockIndex = ensureToolBlock(itemId);
        if (blockIndex === null) return;
        const block = blocks[blockIndex];
        if (!block || block.type !== 'toolCall') return;
        if (state.callId) block.id = state.callId;
        if (state.name) block.name = state.name;
        if (delta.length > 0) {
          toolJsonByBlockIndex.set(blockIndex, state.argumentsText);
          const parsed = parseToolJson(state.argumentsText);
          if (parsed) block.arguments = parsed;
          stream.push({ type: 'toolcall_delta', contentIndex: blockIndex, delta, partial: message });
        }
      };

      const finishToolItem = (itemId: string, callId: string, name: string, finalArgs?: string): void => {
        if (finishedToolItemIds.has(itemId)) return;
        const state = ensureToolState(itemId);
        if (callId) state.callId = callId;
        if (name) state.name = name;
        if (typeof finalArgs === 'string') state.argumentsText = finalArgs;
        const blockIndex = ensureToolBlock(itemId);
        if (blockIndex === null) return;
        const block = blocks[blockIndex];
        if (!block || block.type !== 'toolCall') return;
        if (state.callId) block.id = state.callId;
        if (state.name) block.name = state.name;
        toolJsonByBlockIndex.set(blockIndex, state.argumentsText);
        const parsed = parseToolJson(state.argumentsText);
        if (parsed) block.arguments = parsed;
        finishedToolItemIds.add(itemId);
        stream.push({ type: 'toolcall_end', contentIndex: blockIndex, toolCall: block, partial: message });
      };

      const handleResponsesEventPayload = (payload: Record<string, unknown>): void => {
        const eventType = String(payload.type ?? '');
        if (eventType === 'response.created') {
          setUsage((payload.response as Record<string, unknown> | undefined)?.usage);
          return;
        }
        if (eventType === 'response.output_item.added') {
          const item = (payload.item ?? {}) as Record<string, unknown>;
          const itemId = resolveItemId(payload, item);
          if (item.type === 'message' && itemId.length > 0) {
            appendTextDelta(itemId, extractResponseOutputText(item));
            return;
          }
          if (item.type === 'function_call' && itemId.length > 0) {
            appendToolDelta(itemId, String(item.call_id ?? item.id ?? ''), String(item.name ?? ''), String(item.arguments ?? ''));
          }
          return;
        }
        if (eventType === 'response.output_text.delta') {
          const itemId = resolveItemId(payload);
          if (itemId.length > 0) appendTextDelta(itemId, String(payload.delta ?? ''));
          return;
        }
        if (eventType === 'response.output_text.done') {
          const itemId = resolveItemId(payload);
          if (itemId.length > 0) finishTextItem(itemId, String(payload.text ?? ''));
          return;
        }
        if (eventType === 'response.function_call_arguments.delta') {
          const itemId = resolveItemId(payload);
          if (itemId.length > 0) appendToolDelta(itemId, String(payload.call_id ?? itemId), '', String(payload.delta ?? ''));
          return;
        }
        if (eventType === 'response.function_call_arguments.done') {
          const itemId = resolveItemId(payload);
          if (itemId.length > 0) finishToolItem(itemId, String(payload.call_id ?? itemId), String(payload.name ?? ''), String(payload.arguments ?? ''));
          return;
        }
        if (eventType === 'response.output_item.done') {
          const item = (payload.item ?? {}) as Record<string, unknown>;
          const itemId = resolveItemId(payload, item);
          if (item.type === 'message' && itemId.length > 0) {
            finishTextItem(itemId, extractResponseOutputText(item));
            return;
          }
          if (item.type === 'function_call' && itemId.length > 0) {
            finishToolItem(itemId, String(item.call_id ?? item.id ?? ''), String(item.name ?? ''), String(item.arguments ?? ''));
          }
          return;
        }
        if (eventType === 'response.completed') {
          const responsePayload = (payload.response ?? {}) as Record<string, unknown>;
          setUsage(responsePayload.usage);
          const output = Array.isArray(responsePayload.output) ? responsePayload.output : [];
          for (const [outputIndex, item] of output.entries()) {
            if (!item || typeof item !== 'object') continue;
            const itemRecord = item as Record<string, unknown>;
            const itemId = resolveItemId({ output_index: outputIndex }, itemRecord);
            if (itemRecord.type === 'message' && itemId.length > 0) {
              finishTextItem(itemId, extractResponseOutputText(itemRecord));
              continue;
            }
            if (itemRecord.type === 'function_call' && itemId.length > 0) {
              finishToolItem(itemId, String(itemRecord.call_id ?? itemRecord.id ?? ''), String(itemRecord.name ?? ''), String(itemRecord.arguments ?? ''));
            }
          }
        }
      };

      try {
        const response = await fetch(`${String(model.baseUrl).replace(/\/+$/, '')}/v1/responses`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(providerHint ? { 'x-antseed-provider': providerHint } : {}),
            ...(preferredPeerId ? { 'x-antseed-prefer-peer': preferredPeerId } : {}),
            ...(options?.headers ?? {}),
          },
          body: JSON.stringify(requestBody),
          signal: timeoutController.signal,
        });

        responseMeta = parseProxyMeta(response, startedAt);
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`Proxy returned ${response.status}: ${errorText.slice(0, 280)}`);
        }

        stream.push({ type: 'start', partial: message });
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
          const rawText = await response.text();
          const trimmed = rawText.trimStart();
          if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
            const chunks = rawText.split('\n\n');
            for (const rawChunk of chunks) {
              const lines = rawChunk.split('\n');
              let payloadText = '';
              for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) continue;
                const dataPart = line.slice(5).trim();
                if (dataPart === '[DONE]') {
                  payloadText = '';
                  break;
                }
                payloadText += dataPart;
              }
              if (payloadText.length === 0) continue;
              try {
                handleResponsesEventPayload(JSON.parse(payloadText) as Record<string, unknown>);
              } catch {
                continue;
              }
            }
          } else {
            const payload = JSON.parse(rawText) as { output?: Array<Record<string, unknown>>; output_text?: string; usage?: unknown };
            setUsage(payload.usage);
            const output = Array.isArray(payload.output) ? payload.output : [];
            for (const item of output) {
              if (!item || typeof item !== 'object') continue;
              const itemId = String(item.id ?? '');
              if (item.type === 'message' && itemId.length > 0) {
                const text = extractResponseOutputText(item);
                if (text.length > 0) {
                  appendTextDelta(itemId, text);
                  finishTextItem(itemId, text);
                }
                continue;
              }
              if (item.type === 'function_call' && itemId.length > 0) {
                finishToolItem(itemId, String(item.call_id ?? item.id ?? ''), String(item.name ?? ''), String(item.arguments ?? ''));
              }
            }
            if (output.length === 0 && typeof payload.output_text === 'string' && payload.output_text.length > 0) {
              appendTextDelta('response.output_text', payload.output_text);
              finishTextItem('response.output_text', payload.output_text);
            }
          }
          message.usage.totalTokens = message.usage.totalTokens > 0 ? message.usage.totalTokens : message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
          const doneReason: 'stop' | 'length' | 'toolUse' = message.content.some((block) => block?.type === 'toolCall') ? 'toolUse' : 'stop';
          message.stopReason = doneReason === 'toolUse' ? 'toolUse' : 'stop';
          stream.push({ type: 'done', reason: doneReason, message });
          onMeta({
            ...responseMeta,
            inputTokens: responseMeta.inputTokens || message.usage.input,
            outputTokens: responseMeta.outputTokens || message.usage.output,
            totalTokens: responseMeta.totalTokens || message.usage.totalTokens,
            tokenSource: responseMeta.tokenSource === 'unknown' ? 'usage' : responseMeta.tokenSource,
          });
          stream.end();
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Proxy response is missing stream body');
        let sseBuffer = '';
        const decoder = new TextDecoder();
        resetIdleTimeout();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdleTimeout();
          sseBuffer += decoder.decode(value, { stream: true });
          const chunks = sseBuffer.split('\n\n');
          sseBuffer = chunks.pop() ?? '';
          for (const rawChunk of chunks) {
            const lines = rawChunk.split('\n');
            let payloadText = '';
            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith('data:')) continue;
              payloadText += line.slice(5).trim();
            }
            if (payloadText.length === 0 || payloadText === '[DONE]') continue;
            try {
              handleResponsesEventPayload(JSON.parse(payloadText) as Record<string, unknown>);
            } catch {
              continue;
            }
          }
        }

        message.usage.totalTokens = message.usage.totalTokens > 0 ? message.usage.totalTokens : message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        const doneReason: 'stop' | 'length' | 'toolUse' = message.content.some((block) => block?.type === 'toolCall') ? 'toolUse' : 'stop';
        message.stopReason = doneReason === 'toolUse' ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: doneReason, message });
        onMeta({
          ...responseMeta,
          inputTokens: responseMeta?.inputTokens || message.usage.input,
          outputTokens: responseMeta?.outputTokens || message.usage.output,
          totalTokens: responseMeta?.totalTokens || message.usage.totalTokens,
          tokenSource: responseMeta?.tokenSource === 'unknown' ? 'usage' : responseMeta?.tokenSource,
        });
        stream.end();
      } catch (error) {
        const aborted = Boolean(parentSignal?.aborted);
        const failed: AssistantMessage = {
          ...message,
          stopReason: aborted ? 'aborted' : 'error',
          errorMessage: timeoutErrorMessage ?? (error instanceof Error ? error.message : String(error)),
          timestamp: Date.now(),
        };
        if (responseMeta) onMeta(responseMeta);
        stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: failed });
        stream.end();
      } finally {
        clearIdleTimeout();
        clearTotalTimeout();
        if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
      }
    })();

    return stream;
  };
}
