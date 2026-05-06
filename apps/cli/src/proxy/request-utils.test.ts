import assert from 'node:assert/strict'
import test from 'node:test'
import type { SerializedHttpRequest } from '@antseed/node'
import { ensureChatCompletionsUsageStreamOptions } from './request-utils.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function makeRequest(body: unknown, overrides: Partial<SerializedHttpRequest> = {}): SerializedHttpRequest {
  const encoded = enc.encode(JSON.stringify(body))
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      'content-length': String(encoded.length),
    },
    body: encoded,
    ...overrides,
  } as SerializedHttpRequest
}

function bodyAsObject(req: SerializedHttpRequest): Record<string, unknown> {
  return JSON.parse(dec.decode(req.body)) as Record<string, unknown>
}

test('injects stream_options.include_usage for streaming chat-completions requests', () => {
  const req = makeRequest({
    model: 'minimax-m2.7-highspeed',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    tools: [],
  })
  const out = ensureChatCompletionsUsageStreamOptions(req)
  const body = bodyAsObject(out)
  assert.deepEqual(body.stream_options, { include_usage: true })
  // content-length must be re-synced after body rewrite.
  assert.equal(out.headers['content-length'], String(out.body.length))
})

test('preserves caller-supplied stream_options fields and forces include_usage=true', () => {
  const req = makeRequest({
    model: 'minimax-m2.7-highspeed',
    stream: true,
    stream_options: { include_obfuscation: false },
    messages: [{ role: 'user', content: 'hi' }],
  })
  const out = ensureChatCompletionsUsageStreamOptions(req)
  const body = bodyAsObject(out)
  assert.deepEqual(body.stream_options, { include_obfuscation: false, include_usage: true })
})

test('is a no-op when include_usage is already true', () => {
  const req = makeRequest({
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'hi' }],
  })
  const out = ensureChatCompletionsUsageStreamOptions(req)
  // Same reference returned when nothing needs rewriting.
  assert.equal(out, req)
})

test('does not touch non-streaming chat-completions requests', () => {
  const req = makeRequest({
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const out = ensureChatCompletionsUsageStreamOptions(req)
  assert.equal(out, req)
  const body = bodyAsObject(out)
  assert.equal(body.stream_options, undefined)
})

test('does not touch non-chat-completions paths (e.g. /v1/responses)', () => {
  const req = makeRequest(
    { stream: true, input: 'hi' },
    { path: '/v1/responses' },
  )
  const out = ensureChatCompletionsUsageStreamOptions(req)
  assert.equal(out, req)
})

test('handles empty / non-JSON bodies gracefully', () => {
  const req: SerializedHttpRequest = {
    requestId: 'req-2',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'content-length': '0' },
    body: new Uint8Array(0),
  } as SerializedHttpRequest
  assert.equal(ensureChatCompletionsUsageStreamOptions(req), req)

  const reqText: SerializedHttpRequest = {
    ...req,
    headers: { ...req.headers, 'content-type': 'text/plain' },
    body: enc.encode('hi'),
  }
  assert.equal(ensureChatCompletionsUsageStreamOptions(reqText), reqText)
})

test('updates Content-Length header when present in capitalized form', () => {
  const body = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
  const encoded = enc.encode(body)
  const req: SerializedHttpRequest = {
    requestId: 'req-3',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      'Content-Length': String(encoded.length),
    },
    body: encoded,
  } as SerializedHttpRequest
  const out = ensureChatCompletionsUsageStreamOptions(req)
  assert.equal(out.headers['Content-Length'], String(out.body.length))
})
