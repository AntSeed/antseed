import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type { AssistantMessage, Context, Message, Model, StreamOptions, Tool, ToolResultMessage } from '@mariozechner/pi-ai';

import { resolveRequestMaxTokens } from '../chat-request-budget.js';
import { OPENAI_REASONING_FIELDS, convertToolContentToText, ensureUsageShape, mapStopReason, parseProxyMeta, parseToolJson, type AiMessageMeta } from './common.js';

function openaiContentFromUser(content: Extract<Message, { role: 'user' }>['content']): unknown {
  if (typeof content === 'string') return content;
  const parts: unknown[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (text.length > 0) parts.push({ type: 'text', text });
    } else {
      parts.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
    }
  }
  return parts;
}

function convertContextMessagesToOpenAI(messages: Message[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      const content = openaiContentFromUser(message.content);
      if (typeof content === 'string' && content.length === 0) continue;
      if (Array.isArray(content) && content.length === 0) continue;
      converted.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant') {
      let textContent = '';
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of message.content) {
        if (!block) continue;
        if (block.type === 'text') textContent += block.text ?? '';
        else if (block.type === 'toolCall') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
          });
        }
      }
      if (toolCalls.length > 0) {
        const nextMessage = messages[index + 1];
        if (!nextMessage || nextMessage.role !== 'toolResult') {
          converted.push({ role: 'assistant', content: textContent || '…' });
          continue;
        }
      }
      const entry: Record<string, unknown> = { role: 'assistant' };
      if (textContent.length > 0 || toolCalls.length === 0) entry.content = textContent || '…';
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      converted.push(entry);
      continue;
    }
    if (message.role === 'toolResult') {
      let toolIndex = index;
      while (toolIndex < messages.length) {
        const toolMessage = messages[toolIndex];
        if (!toolMessage || toolMessage.role !== 'toolResult') break;
        const toolResult = toolMessage as ToolResultMessage;
        converted.push({
          role: 'tool',
          tool_call_id: toolResult.toolCallId,
          content: convertToolContentToText(toolResult.content) || '(no tool output)',
        });
        toolIndex += 1;
      }
      index = toolIndex - 1;
    }
  }
  return converted;
}

function convertToolsToOpenAI(tools?: Tool[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function createBuyerProxyOpenAIStreamFn(
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

      const openaiMessages = convertContextMessagesToOpenAI(context.messages);
      if (context.systemPrompt) openaiMessages.unshift({ role: 'system', content: context.systemPrompt });
      const requestBody: Record<string, unknown> = {
        model: model.id,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: resolveRequestMaxTokens(model, options),
      };
      const openaiTools = convertToolsToOpenAI(context.tools);
      if (openaiTools) requestBody.tools = openaiTools;

      let responseMeta: AiMessageMeta | undefined;
      try {
        const response = await fetch(`${String(model.baseUrl).replace(/\/+$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
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
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Proxy response is missing stream body');

        let sseBuffer = '';
        const decoder = new TextDecoder();
        let currentTextOrThinkBlock: AssistantMessage['content'][number] | null = null;
        let currentTextOrThinkIndex = -1;
        const blocks = message.content;
        const toolJsonByBlockIndex = new Map<number, string>();
        const toolCallIndexToBlockIndex = new Map<number, number>();

        const finishTextOrThinkBlock = (): void => {
          if (!currentTextOrThinkBlock) return;
          if (currentTextOrThinkBlock.type === 'text') stream.push({ type: 'text_end', contentIndex: currentTextOrThinkIndex, content: currentTextOrThinkBlock.text, partial: message });
          else if (currentTextOrThinkBlock.type === 'thinking') stream.push({ type: 'thinking_end', contentIndex: currentTextOrThinkIndex, content: currentTextOrThinkBlock.thinking, partial: message });
          currentTextOrThinkBlock = null;
          currentTextOrThinkIndex = -1;
        };

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
            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payloadText) as Record<string, unknown>;
            } catch {
              continue;
            }

            const usage = chunk.usage as Record<string, unknown> | undefined;
            if (usage) {
              const promptTokens = Number(usage.prompt_tokens ?? 0);
              const completionTokens = Number(usage.completion_tokens ?? 0);
              const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
              const cachedTokens = Number(promptDetails?.cached_tokens ?? 0);
              const inputTokens = promptTokens - cachedTokens;
              message.usage.input = inputTokens;
              message.usage.output = completionTokens;
              message.usage.cacheRead = cachedTokens;
              message.usage.totalTokens = inputTokens + completionTokens + cachedTokens;
            }

            const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
            if (!choice) continue;
            if (choice.finish_reason) message.stopReason = mapStopReason(choice.finish_reason);
            const delta = choice.delta as Record<string, unknown> | undefined;
            if (!delta) continue;

            if (delta.content !== null && delta.content !== undefined && String(delta.content).length > 0) {
              const textDelta = String(delta.content);
              if (!currentTextOrThinkBlock || currentTextOrThinkBlock.type !== 'text') {
                finishTextOrThinkBlock();
                currentTextOrThinkBlock = { type: 'text', text: '' };
                blocks.push(currentTextOrThinkBlock);
                currentTextOrThinkIndex = blocks.length - 1;
                stream.push({ type: 'text_start', contentIndex: currentTextOrThinkIndex, partial: message });
              }
              if (currentTextOrThinkBlock.type === 'text') {
                currentTextOrThinkBlock.text += textDelta;
                stream.push({ type: 'text_delta', contentIndex: currentTextOrThinkIndex, delta: textDelta, partial: message });
              }
            }

            let foundReasoning: string | null = null;
            for (const field of OPENAI_REASONING_FIELDS) {
              const val = delta[field];
              if (val !== null && val !== undefined && String(val).length > 0) {
                foundReasoning = String(val);
                break;
              }
            }
            if (foundReasoning) {
              if (!currentTextOrThinkBlock || currentTextOrThinkBlock.type !== 'thinking') {
                finishTextOrThinkBlock();
                currentTextOrThinkBlock = { type: 'thinking', thinking: '' };
                blocks.push(currentTextOrThinkBlock);
                currentTextOrThinkIndex = blocks.length - 1;
                stream.push({ type: 'thinking_start', contentIndex: currentTextOrThinkIndex, partial: message });
              }
              if (currentTextOrThinkBlock.type === 'thinking') {
                currentTextOrThinkBlock.thinking += foundReasoning;
                stream.push({ type: 'thinking_delta', contentIndex: currentTextOrThinkIndex, delta: foundReasoning, partial: message });
              }
            }

            const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
            if (toolCalls) {
              for (const tc of toolCalls) {
                const tcIndex = Number(tc.index ?? 0);
                const tcId = tc.id as string | undefined;
                const tcFunc = tc.function as Record<string, unknown> | undefined;
                let blockIndex = toolCallIndexToBlockIndex.get(tcIndex);
                if (blockIndex === undefined) {
                  finishTextOrThinkBlock();
                  const toolBlock = {
                    type: 'toolCall' as const,
                    id: tcId ?? '',
                    name: (tcFunc?.name as string) ?? '',
                    arguments: {} as Record<string, unknown>,
                  };
                  blocks.push(toolBlock);
                  blockIndex = blocks.length - 1;
                  toolCallIndexToBlockIndex.set(tcIndex, blockIndex);
                  toolJsonByBlockIndex.set(blockIndex, '');
                  stream.push({ type: 'toolcall_start', contentIndex: blockIndex, partial: message });
                }
                const block = blocks[blockIndex];
                if (block && block.type === 'toolCall') {
                  if (tcId) block.id = tcId;
                  if (tcFunc?.name) block.name = tcFunc.name as string;
                  let argsDelta = '';
                  if (tcFunc?.arguments) {
                    argsDelta = String(tcFunc.arguments);
                    const merged = `${toolJsonByBlockIndex.get(blockIndex) ?? ''}${argsDelta}`;
                    toolJsonByBlockIndex.set(blockIndex, merged);
                    const parsed = parseToolJson(merged);
                    if (parsed) block.arguments = parsed;
                  }
                  stream.push({ type: 'toolcall_delta', contentIndex: blockIndex, delta: argsDelta, partial: message });
                }
              }
            }
          }
        }

        finishTextOrThinkBlock();
        for (const [, blockIndex] of toolCallIndexToBlockIndex) {
          const block = blocks[blockIndex];
          if (block && block.type === 'toolCall') {
            const parsed = parseToolJson(toolJsonByBlockIndex.get(blockIndex) ?? '');
            if (parsed) block.arguments = parsed;
            stream.push({ type: 'toolcall_end', contentIndex: blockIndex, toolCall: block, partial: message });
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
