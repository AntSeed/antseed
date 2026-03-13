import type {
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from '@antseed/node'
import {
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
} from '@antseed/node'

export {
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
}

export type {
  ServiceApiProtocol,
  TargetProtocolSelection,
  AnthropicToOpenAIRequestTransformResult,
  ResponsesToOpenAIRequestTransformResult,
} from '@antseed/node'

export interface StreamingResponseAdapter {
  adaptStart(response: SerializedHttpResponse): SerializedHttpResponse
  adaptChunk(chunk: SerializedHttpResponseChunk): SerializedHttpResponseChunk[]
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function parseSseBuffer(buffer: string): { events: Array<{ data: string }>; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const remainder = blocks.pop() ?? ''
  const events = blocks
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')) ?? '')
    .filter((line) => line.length > 0)
    .map((line) => ({ data: line.slice('data: '.length) }))
  return { events, remainder }
}

function encodeSseEvents(events: Array<{ event?: string; data: unknown | string }>): Uint8Array {
  const chunks: string[] = []
  for (const item of events) {
    if (item.event) {
      chunks.push(`event: ${item.event}\n`)
    }
    const data = typeof item.data === 'string' ? item.data : JSON.stringify(item.data)
    chunks.push(`data: ${data}\n\n`)
  }
  return new TextEncoder().encode(chunks.join(''))
}

function toNonNegativeInt(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }
  return Math.floor(parsed)
}

function mapFinishReasonToAnthropicStopReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  if (value === 'stop') return 'end_turn'
  if (value === 'length') return 'max_tokens'
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use'
  return value
}

export function createOpenAIChatToAnthropicStreamingAdapter(
  options: { fallbackModel?: string | null },
): StreamingResponseAdapter {
  let rawBuffer = ''
  let messageStarted = false
  let textBlockStarted = false
  let outputTokens = 0
  let stopReason: string | null = null
  let messageId = options.fallbackModel ? `msg_${options.fallbackModel}` : 'msg_stream'
  let service = options.fallbackModel ?? 'unknown'

  const startMessage = (): Array<{ event: string; data: unknown }> => {
    if (messageStarted) return []
    messageStarted = true
    return [{
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: service,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    }]
  }

  const startTextBlock = (): Array<{ event: string; data: unknown }> => {
    if (textBlockStarted) return []
    textBlockStarted = true
    return [{
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      },
    }]
  }

  return {
    adaptStart(response) {
      return {
        ...response,
        headers: {
          ...response.headers,
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: new Uint8Array(0),
      }
    },
    adaptChunk(chunk) {
      const out: SerializedHttpResponseChunk[] = []
      if (chunk.data.length > 0) {
        rawBuffer += new TextDecoder().decode(chunk.data, { stream: !chunk.done })
      }
      const { events, remainder } = parseSseBuffer(rawBuffer)
      rawBuffer = remainder
      const emitted: Array<{ event?: string; data: unknown | string }> = []

      for (const event of events) {
        if (event.data === '[DONE]') continue
        const parsed = parseJsonSafe(event.data)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const payload = parsed as Record<string, unknown>
        if (typeof payload.id === 'string' && payload.id.length > 0) messageId = payload.id
        if (typeof payload.model === 'string' && payload.model.length > 0) service = payload.model
        const usage = payload.usage && typeof payload.usage === 'object'
          ? payload.usage as Record<string, unknown>
          : null
        if (usage) {
          outputTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens)
        }
        const choices = Array.isArray(payload.choices) ? payload.choices : []
        const firstChoice = choices[0] && typeof choices[0] === 'object'
          ? choices[0] as Record<string, unknown>
          : null
        const delta = firstChoice?.delta && typeof firstChoice.delta === 'object'
          ? firstChoice.delta as Record<string, unknown>
          : null
        if (typeof firstChoice?.finish_reason === 'string' && firstChoice.finish_reason.length > 0) {
          stopReason = mapFinishReasonToAnthropicStopReason(firstChoice.finish_reason)
        }
        const textDelta = typeof delta?.content === 'string' ? delta.content : ''
        if (textDelta.length > 0) {
          emitted.push(...startMessage())
          emitted.push(...startTextBlock())
          emitted.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: textDelta,
              },
            },
          })
        }
      }

      if (chunk.done) {
        if (!messageStarted) {
          emitted.push(...startMessage())
        }
        if (textBlockStarted) {
          emitted.push({
            event: 'content_block_stop',
            data: {
              type: 'content_block_stop',
              index: 0,
            },
          })
        }
        emitted.push({
          event: 'message_delta',
          data: {
            type: 'message_delta',
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
            },
            usage: {
              output_tokens: outputTokens,
            },
          },
        })
        emitted.push({
          event: 'message_stop',
          data: {
            type: 'message_stop',
          },
        })
      }

      if (emitted.length > 0) {
        out.push({
          requestId: chunk.requestId,
          data: encodeSseEvents(emitted),
          done: chunk.done,
        })
      } else if (chunk.done) {
        out.push({ requestId: chunk.requestId, data: new Uint8Array(0), done: true })
      }
      return out
    },
  }
}

export function createOpenAIChatToResponsesStreamingAdapter(
  options: { fallbackModel?: string | null },
): StreamingResponseAdapter {
  let rawBuffer = ''
  let sequenceNumber = 0
  let responseCreated = false
  let outputStarted = false
  let outputDone = false
  let responseId = options.fallbackModel ? `resp_${options.fallbackModel}` : 'resp_stream'
  let responseModel = options.fallbackModel ?? 'unknown'
  let textBuffer = ''
  let outputTokens = 0

  const pushEvent = (
    emitted: Array<{ event?: string; data: unknown | string }>,
    event: string,
    data: Record<string, unknown>,
  ): void => {
    emitted.push({
      event,
      data: {
        type: event,
        sequence_number: sequenceNumber++,
        ...data,
      },
    })
  }

  const ensureStarted = (emitted: Array<{ event?: string; data: unknown | string }>): void => {
    if (!responseCreated) {
      responseCreated = true
      pushEvent(emitted, 'response.created', {
        response: {
          id: responseId,
          object: 'response',
          model: responseModel,
          status: 'in_progress',
          created_at: Math.floor(Date.now() / 1000),
          output: [],
          output_text: '',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
      })
    }
    if (!outputStarted) {
      outputStarted = true
      pushEvent(emitted, 'response.output_item.added', {
        output_index: 0,
        item: {
          type: 'message',
          id: `${responseId}_msg_1`,
          role: 'assistant',
          status: 'in_progress',
          content: [{
            type: 'output_text',
            text: '',
            annotations: [],
          }],
        },
      })
      pushEvent(emitted, 'response.content_part.added', {
        output_index: 0,
        item_id: `${responseId}_msg_1`,
        content_index: 0,
        part: {
          type: 'output_text',
          text: '',
          annotations: [],
        },
      })
    }
  }

  return {
    adaptStart(response) {
      return {
        ...response,
        headers: {
          ...response.headers,
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: new Uint8Array(0),
      }
    },
    adaptChunk(chunk) {
      const out: SerializedHttpResponseChunk[] = []
      if (chunk.data.length > 0) {
        rawBuffer += new TextDecoder().decode(chunk.data, { stream: !chunk.done })
      }
      const { events, remainder } = parseSseBuffer(rawBuffer)
      rawBuffer = remainder
      const emitted: Array<{ event?: string; data: unknown | string }> = []

      for (const event of events) {
        if (event.data === '[DONE]') continue
        const parsed = parseJsonSafe(event.data)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const payload = parsed as Record<string, unknown>
        if (typeof payload.id === 'string' && payload.id.length > 0) responseId = payload.id
        if (typeof payload.model === 'string' && payload.model.length > 0) responseModel = payload.model
        const usage = payload.usage && typeof payload.usage === 'object'
          ? payload.usage as Record<string, unknown>
          : null
        if (usage) {
          outputTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens)
        }
        const choices = Array.isArray(payload.choices) ? payload.choices : []
        const firstChoice = choices[0] && typeof choices[0] === 'object'
          ? choices[0] as Record<string, unknown>
          : null
        const delta = firstChoice?.delta && typeof firstChoice.delta === 'object'
          ? firstChoice.delta as Record<string, unknown>
          : null
        const textDelta = typeof delta?.content === 'string' ? delta.content : ''
        if (textDelta.length > 0) {
          ensureStarted(emitted)
          textBuffer += textDelta
          pushEvent(emitted, 'response.output_text.delta', {
            output_index: 0,
            item_id: `${responseId}_msg_1`,
            content_index: 0,
            delta: textDelta,
            logprobs: [],
          })
        }
      }

      if (chunk.done && !outputDone) {
        ensureStarted(emitted)
        outputDone = true
        pushEvent(emitted, 'response.output_text.done', {
          output_index: 0,
          item_id: `${responseId}_msg_1`,
          content_index: 0,
          text: textBuffer,
          logprobs: [],
        })
        pushEvent(emitted, 'response.content_part.done', {
          output_index: 0,
          item_id: `${responseId}_msg_1`,
          content_index: 0,
          part: {
            type: 'output_text',
            text: textBuffer,
            annotations: [],
          },
        })
        pushEvent(emitted, 'response.output_item.done', {
          output_index: 0,
          item: {
            type: 'message',
            id: `${responseId}_msg_1`,
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: textBuffer,
              annotations: [],
            }],
          },
        })
        pushEvent(emitted, 'response.completed', {
          response: {
            id: responseId,
            object: 'response',
            model: responseModel,
            status: 'completed',
            created_at: Math.floor(Date.now() / 1000),
            output: [{
              type: 'message',
              id: `${responseId}_msg_1`,
              role: 'assistant',
              status: 'completed',
              content: [{
                type: 'output_text',
                text: textBuffer,
                annotations: [],
              }],
            }],
            output_text: textBuffer,
            usage: {
              input_tokens: 0,
              output_tokens: outputTokens,
              total_tokens: outputTokens,
            },
          },
        })
        emitted.push({ data: '[DONE]' })
      }

      if (emitted.length > 0) {
        out.push({
          requestId: chunk.requestId,
          data: encodeSseEvents(emitted),
          done: chunk.done,
        })
      } else if (chunk.done) {
        out.push({ requestId: chunk.requestId, data: new Uint8Array(0), done: true })
      }
      return out
    },
  }
}
