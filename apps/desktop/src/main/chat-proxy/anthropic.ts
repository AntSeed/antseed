import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type { AssistantMessage, Context, Message, Model, StreamOptions, Tool, ToolResultMessage } from '@mariozechner/pi-ai';

import { resolveRequestMaxTokens } from '../chat-request-budget.js';
import { ensureUsageShape, parseProxyMeta, parseToolJson, convertToolContentToText, mapStopReason, type AiMessageMeta } from './common.js';

function anthropicContentFromUser(content: Extract<Message, { role: 'user' }>['content']): unknown {
  if (typeof content === 'string') return content;
  const blocks: unknown[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (text.length > 0) blocks.push({ type: 'text', text });
      continue;
    }
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.mimeType,
        data: block.data,
      },
    });
  }
  return blocks;
}

function anthropicContentFromAssistant(content: AssistantMessage['content']): unknown[] {
  const blocks: unknown[] = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (text.length > 0) blocks.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'thinking') continue;
    blocks.push({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.arguments ?? {},
    });
  }
  return blocks;
}

function anthropicContentFromToolResult(message: ToolResultMessage): unknown[] {
  const content = convertToolContentToText(message.content);
  return [{
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content: content.length > 0 ? content : '(no tool output)',
    is_error: message.isError,
  }];
}

function getAssistantToolUseIds(content: unknown[]): string[] {
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (typedBlock.type !== 'tool_use') continue;
    const id = String(typedBlock.id ?? '').trim();
    if (id.length > 0) ids.push(id);
  }
  return ids;
}

function getToolResultIdFromAnthropicBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const typedBlock = block as { type?: unknown; tool_use_id?: unknown };
  if (typedBlock.type !== 'tool_result') return null;
  const id = String(typedBlock.tool_use_id ?? '').trim();
  return id.length > 0 ? id : null;
}

function convertContextMessagesToAnthropic(messages: Message[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      const content = anthropicContentFromUser(message.content);
      if (typeof content === 'string' && content.length === 0) continue;
      if (Array.isArray(content) && content.length === 0) continue;
      converted.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant') {
      let content = anthropicContentFromAssistant(message.content);
      const toolUseIds = getAssistantToolUseIds(content);
      if (toolUseIds.length > 0) {
        const nextMessage = messages[index + 1];
        if (!nextMessage || nextMessage.role !== 'toolResult') {
          content = content.filter((block) => {
            if (!block || typeof block !== 'object') return false;
            return (block as { type?: unknown }).type !== 'tool_use';
          });
        }
      }
      converted.push({
        role: 'assistant',
        content: content.length > 0 ? content : [{ type: 'text', text: '…' }],
      });
      continue;
    }
    if (message.role === 'toolResult') {
      const contentBlocks: unknown[] = [];
      let toolIndex = index;
      while (toolIndex < messages.length) {
        const toolMessage = messages[toolIndex];
        if (!toolMessage || toolMessage.role !== 'toolResult') break;
        contentBlocks.push(...anthropicContentFromToolResult(toolMessage as ToolResultMessage));
        toolIndex += 1;
      }
      index = toolIndex - 1;
      const filteredBlocks = contentBlocks.filter((block) => getToolResultIdFromAnthropicBlock(block) !== null);
      if (filteredBlocks.length > 0) {
        converted.push({ role: 'user', content: filteredBlocks });
      }
    }
  }
  return converted;
}

function convertToolsToAnthropic(tools?: Tool[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function createBuyerProxyAnthropicStreamFn(
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
    const triggerTimeoutAbort = (message: string): void => {
      if (timeoutController.signal.aborted) return;
      timeoutErrorMessage = message;
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

      const requestBodyJson = JSON.stringify({
        model: model.id,
        max_tokens: resolveRequestMaxTokens(model, options),
        stream: true,
        ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
        ...(context.tools ? { tools: convertToolsToAnthropic(context.tools) } : {}),
        messages: convertContextMessagesToAnthropic(context.messages),
      });

      let responseMeta: AiMessageMeta | undefined;

      const setUsage = (usageData: unknown): void => {
        const next = ensureUsageShape(usageData as Partial<import('@mariozechner/pi-ai').Usage>);
        if (next.input > 0) message.usage.input = next.input;
        if (next.output > 0) message.usage.output = next.output;
        if (next.cacheRead > 0) message.usage.cacheRead = next.cacheRead;
        if (next.cacheWrite > 0) message.usage.cacheWrite = next.cacheWrite;
        if (next.totalTokens > 0) message.usage.totalTokens = next.totalTokens;
      };

      try {
        const response = await fetch(`${String(model.baseUrl).replace(/\/+$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(providerHint ? { 'x-antseed-provider': providerHint } : {}),
            ...(preferredPeerId ? { 'x-antseed-prefer-peer': preferredPeerId } : {}),
            ...(options?.headers ?? {}),
          },
          body: requestBodyJson,
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
          const payload = await response.json() as {
            content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
            usage?: unknown;
            stop_reason?: string;
          };
          setUsage(payload.usage);
          const blocks = payload.content ?? [];
          for (let index = 0; index < blocks.length; index += 1) {
            const block = blocks[index];
            if (!block) continue;
            if (block.type === 'text') {
              const text = String(block.text ?? '');
              message.content.push({ type: 'text', text });
              stream.push({ type: 'text_start', contentIndex: index, partial: message });
              stream.push({ type: 'text_delta', contentIndex: index, delta: text, partial: message });
              stream.push({ type: 'text_end', contentIndex: index, content: text, partial: message });
              continue;
            }
            if (block.type === 'thinking') {
              const thinking = String(block.thinking ?? '');
              message.content.push({ type: 'thinking', thinking });
              stream.push({ type: 'thinking_start', contentIndex: index, partial: message });
              stream.push({ type: 'thinking_delta', contentIndex: index, delta: thinking, partial: message });
              stream.push({ type: 'thinking_end', contentIndex: index, content: thinking, partial: message });
              continue;
            }
            if (block.type === 'tool_use') {
              const toolCall = {
                type: 'toolCall' as const,
                id: String(block.id ?? `tool-${String(index)}`),
                name: String(block.name ?? 'tool'),
                arguments: (block.input ?? {}) as Record<string, unknown>,
              };
              message.content.push(toolCall);
              stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
              stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message });
            }
          }
          message.stopReason = mapStopReason(payload.stop_reason);
          message.usage.totalTokens = message.usage.totalTokens > 0 ? message.usage.totalTokens : message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
          stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : (message.stopReason === 'length' ? 'length' : 'stop'), message });
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
        const toolJsonByContentIndex = new Map<number, string>();

        resetIdleTimeout();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdleTimeout();
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const payloadText = line.slice(5).trim();
            if (payloadText.length === 0 || payloadText === '[DONE]') continue;
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(payloadText) as Record<string, unknown>;
            } catch {
              continue;
            }

            const eventType = String(payload.type ?? '');
            if (eventType === 'message_start') {
              setUsage((payload.message as Record<string, unknown> | undefined)?.usage);
              continue;
            }
            if (eventType === 'content_block_start') {
              const index = Number(payload.index ?? 0);
              const block = (payload.content_block ?? {}) as Record<string, unknown>;
              const blockType = String(block.type ?? 'text');
              if (blockType === 'text') {
                const text = String(block.text ?? '');
                message.content[index] = { type: 'text', text };
                stream.push({ type: 'text_start', contentIndex: index, partial: message });
                if (text.length > 0) stream.push({ type: 'text_delta', contentIndex: index, delta: text, partial: message });
                continue;
              }
              if (blockType === 'thinking') {
                const thinking = String(block.thinking ?? '');
                message.content[index] = { type: 'thinking', thinking };
                stream.push({ type: 'thinking_start', contentIndex: index, partial: message });
                if (thinking.length > 0) stream.push({ type: 'thinking_delta', contentIndex: index, delta: thinking, partial: message });
                continue;
              }
              if (blockType === 'tool_use') {
                const toolCall = {
                  type: 'toolCall' as const,
                  id: String(block.id ?? `tool-${String(index)}`),
                  name: String(block.name ?? 'tool'),
                  arguments: (block.input ?? {}) as Record<string, unknown>,
                };
                message.content[index] = toolCall;
                toolJsonByContentIndex.set(index, '');
                stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
              } else {
                message.content[index] = { type: 'thinking', thinking: '' };
              }
              continue;
            }
            if (eventType === 'content_block_delta') {
              const index = Number(payload.index ?? 0);
              const delta = (payload.delta ?? {}) as Record<string, unknown>;
              const deltaType = String(delta.type ?? '');
              if (deltaType === 'text_delta') {
                const current = message.content[index];
                const nextDelta = String(delta.text ?? '');
                if (current && current.type === 'text') current.text += nextDelta;
                stream.push({ type: 'text_delta', contentIndex: index, delta: nextDelta, partial: message });
                continue;
              }
              if (deltaType === 'thinking_delta') {
                const current = message.content[index];
                const nextDelta = String(delta.thinking ?? '');
                if (current && current.type === 'thinking') current.thinking += nextDelta;
                stream.push({ type: 'thinking_delta', contentIndex: index, delta: nextDelta, partial: message });
                continue;
              }
              if (deltaType === 'input_json_delta') {
                const nextDelta = String(delta.partial_json ?? '');
                const merged = `${toolJsonByContentIndex.get(index) ?? ''}${nextDelta}`;
                toolJsonByContentIndex.set(index, merged);
                const current = message.content[index];
                if (current && current.type === 'toolCall') {
                  const parsed = parseToolJson(merged);
                  if (parsed) current.arguments = parsed;
                }
                stream.push({ type: 'toolcall_delta', contentIndex: index, delta: nextDelta, partial: message });
              }
              continue;
            }
            if (eventType === 'content_block_stop') {
              const index = Number(payload.index ?? 0);
              const current = message.content[index];
              if (!current) continue;
              if (current.type === 'text') {
                stream.push({ type: 'text_end', contentIndex: index, content: current.text, partial: message });
              } else if (current.type === 'thinking') {
                stream.push({ type: 'thinking_end', contentIndex: index, content: current.thinking, partial: message });
              } else if (current.type === 'toolCall') {
                const parsed = parseToolJson(toolJsonByContentIndex.get(index) ?? '');
                if (parsed) current.arguments = parsed;
                stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: current, partial: message });
              }
              continue;
            }
            if (eventType === 'message_delta' || eventType === 'message_stop') {
              setUsage(payload.usage);
              setUsage((payload.message as Record<string, unknown> | undefined)?.usage);
              const delta = payload.delta as Record<string, unknown> | undefined;
              if (delta?.stop_reason !== undefined) message.stopReason = mapStopReason(delta.stop_reason);
            }
          }
        }

        message.usage.totalTokens = message.usage.totalTokens > 0 ? message.usage.totalTokens : message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        const doneReason: 'stop' | 'length' | 'toolUse' = message.stopReason === 'toolUse' ? 'toolUse' : (message.stopReason === 'length' ? 'length' : 'stop');
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
