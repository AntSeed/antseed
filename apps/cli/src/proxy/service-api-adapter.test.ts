import assert from 'node:assert/strict'
import test from 'node:test'
import {
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
} from './service-api-adapter.js'
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

test('preserves plain string message content', () => {
  const result = transformAnthropicMessagesRequestToOpenAIChat(
    makeRequest({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100 }),
  )
  assert.notEqual(result, null)
  const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ content: string }> }
  assert.equal(body.messages[0]!.content, 'Hello')
})

test('does NOT produce [object Object] for array content blocks', () => {
  // Regression: Claude Code sends content as [{type:'text', text:'...'}]
  const result = transformAnthropicMessagesRequestToOpenAIChat(
    makeRequest({
      model: 'claude-3-5-haiku-20241022',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
      ],
      max_tokens: 100,
    }),
  )
  assert.notEqual(result, null)
  const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ role: string; content: string }> }
  const userMsg = body.messages.find((m) => m.role === 'user')
  assert.equal(userMsg!.content, 'What is 2+2?')
  assert.notEqual(userMsg!.content, '[object Object]')
})

test('does NOT produce [object Object] for multi-block user messages', () => {
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
  assert.notEqual(result, null)
  const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ role: string; content: string }> }
  const userMsg = body.messages.find((m) => m.role === 'user')
  assert.equal(userMsg!.content, 'Line one\nLine two')
  assert.equal(userMsg!.content.includes('[object Object]'), false)
})

test('does NOT produce [object Object] for assistant array content blocks', () => {
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
  assert.notEqual(result, null)
  const body = JSON.parse(dec.decode(result!.request.body)) as { messages: Array<{ role: string; content: string }> }
  const assistantMsg = body.messages.find((m) => m.role === 'assistant')
  assert.equal(assistantMsg!.content, 'Hello there!')
  assert.notEqual(assistantMsg!.content, '[object Object]')
})

test('removes anthropic-version header', () => {
  const result = transformAnthropicMessagesRequestToOpenAIChat(
    makeRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
  )
  assert.notEqual(result, null)
  assert.equal(result!.request.headers['anthropic-version'], undefined)
})

test('rewrites path to /v1/chat/completions', () => {
  const result = transformAnthropicMessagesRequestToOpenAIChat(
    makeRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
  )
  assert.equal(result!.request.path, '/v1/chat/completions')
})

test('returns null for non-messages paths', () => {
  const req = makeRequest({ messages: [] }, '/v1/embeddings')
  assert.equal(transformAnthropicMessagesRequestToOpenAIChat(req), null)
})

test('converts a basic OpenAI response to Anthropic format', () => {
  const oaiBody = {
    id: 'chatcmpl-abc',
    model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
  const resp: SerializedHttpResponse = {
    requestId: 'r1',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify(oaiBody)),
  }
  const result = transformOpenAIChatResponseToAnthropicMessage(resp, { streamRequested: false })
  const body = JSON.parse(dec.decode(result.body)) as {
    type: string
    content: Array<{ type: string; text: string }>
  }
  assert.equal(body.type, 'message')
  assert.equal(body.content[0]!.type, 'text')
  assert.equal(body.content[0]!.text, 'Hello!')
})

test('maps finish_reason stop → end_turn', () => {
  const oaiBody = {
    id: 'x',
    model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
  const resp: SerializedHttpResponse = {
    requestId: 'r1',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify(oaiBody)),
  }
  const result = transformOpenAIChatResponseToAnthropicMessage(resp, { streamRequested: false })
  const body = JSON.parse(dec.decode(result.body)) as { stop_reason: string }
  assert.equal(body.stop_reason, 'end_turn')
})
