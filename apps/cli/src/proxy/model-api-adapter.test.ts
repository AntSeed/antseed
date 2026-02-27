import { describe, it, expect } from 'vitest'
import {
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
} from './model-api-adapter.js'
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node'

const enc = new TextEncoder()
const dec = new TextDecoder()

function makeRequest(body: unknown, path = '/v1/messages'): SerializedHttpRequest {
  return {
    requestId: 'r1',
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: enc.encode(JSON.stringify(body)),
  }
}

describe('transformAnthropicMessagesRequestToOpenAIChat', () => {
  it('preserves plain string message content', () => {
    const result = transformAnthropicMessagesRequestToOpenAIChat(
      makeRequest({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100 }),
    )
    expect(result).not.toBeNull()
    const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ content: string }> }
    expect(body.messages[0]!.content).toBe('Hello')
  })

  it('does NOT produce [object Object] for array content blocks', () => {
    // This is the regression case: Claude Code sends content as [{type:'text', text:'...'}]
    const result = transformAnthropicMessagesRequestToOpenAIChat(
      makeRequest({
        model: 'claude-3-5-haiku-20241022',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        ],
        max_tokens: 100,
      }),
    )
    expect(result).not.toBeNull()
    const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ role: string; content: string }> }
    const userMsg = body.messages.find((m) => m.role === 'user')
    expect(userMsg!.content).toBe('What is 2+2?')
    expect(userMsg!.content).not.toBe('[object Object]')
  })

  it('does NOT produce [object Object] for multi-block user messages', () => {
    const result = transformAnthropicMessagesRequestToOpenAIChat(
      makeRequest({
        model: 'claude-3-5-haiku-20241022',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Line one' },
              { type: 'text', text: 'Line two' },
            ],
          },
        ],
        max_tokens: 100,
      }),
    )
    expect(result).not.toBeNull()
    const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ role: string; content: string }> }
    const userMsg = body.messages.find((m) => m.role === 'user')
    expect(userMsg!.content).toBe('Line one\nLine two')
    expect(userMsg!.content).not.toContain('[object Object]')
  })

  it('does NOT produce [object Object] for assistant array content blocks', () => {
    const result = transformAnthropicMessagesRequestToOpenAIChat(
      makeRequest({
        model: 'claude-3-5-haiku-20241022',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello there!' }] },
          { role: 'user', content: 'Good' },
        ],
        max_tokens: 100,
      }),
    )
    expect(result).not.toBeNull()
    const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ role: string; content: string }> }
    const assistantMsg = body.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg!.content).toBe('Hello there!')
    expect(assistantMsg!.content).not.toBe('[object Object]')
  })

  it('removes anthropic-version and anthropic-beta headers', () => {
    const result = transformAnthropicMessagesRequestToOpenAIChat(
      makeRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    )
    expect(result).not.toBeNull()
    expect(result!.request.headers['anthropic-version']).toBeUndefined()
  })

  it('rewrites path to /v1/chat/completions', () => {
    const result = transformAnthropicMessagesRequestToOpenAIChat(
      makeRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    )
    expect(result!.request.path).toBe('/v1/chat/completions')
  })

  it('returns null for non-messages paths', () => {
    const req = makeRequest({ messages: [] }, '/v1/embeddings')
    expect(transformAnthropicMessagesRequestToOpenAIChat(req)).toBeNull()
  })
})

describe('transformOpenAIChatResponseToAnthropicMessage', () => {
  function makeOAIResponse(body: unknown, statusCode = 200): SerializedHttpResponse {
    return {
      requestId: 'r1',
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: enc.encode(JSON.stringify(body)),
    }
  }

  it('converts a basic OpenAI response to Anthropic format', () => {
    const oaiBody = {
      id: 'chatcmpl-abc',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }
    const result = transformOpenAIChatResponseToAnthropicMessage(
      makeOAIResponse(oaiBody),
      { streamRequested: false },
    )
    const body = JSON.parse(dec.decode(result.body)) as {
      type: string
      content: Array<{ type: string; text: string }>
    }
    expect(body.type).toBe('message')
    expect(body.content[0]!.type).toBe('text')
    expect(body.content[0]!.text).toBe('Hello!')
  })

  it('maps finish_reason stop → end_turn', () => {
    const oaiBody = {
      id: 'x',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }
    const result = transformOpenAIChatResponseToAnthropicMessage(
      makeOAIResponse(oaiBody),
      { streamRequested: false },
    )
    const body = JSON.parse(dec.decode(result.body)) as { stop_reason: string }
    expect(body.stop_reason).toBe('end_turn')
  })
})
