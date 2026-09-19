import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractRoutingUsage } from './routing-usage.js'

const json = (value: unknown) => Buffer.from(JSON.stringify(value))

test('routing usage distinguishes missing cache fields, reported zero, and absent usage', () => {
  assert.deepEqual(extractRoutingUsage({}, json({ usage: { prompt_tokens: 10 } })), { inputTokens: 10 })
  assert.deepEqual(extractRoutingUsage({}, json({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } })), { inputTokens: 10, cachedInputTokens: 0 })
  assert.deepEqual(extractRoutingUsage({}, json({ usage: { input_tokens: 0, cache_read_input_tokens: 0 } })), { inputTokens: 0, cachedInputTokens: 0 })
  assert.equal(extractRoutingUsage({}, json({ text: 'Do not estimate me' })), undefined)
  assert.equal(extractRoutingUsage({}, json({ usage: { output_tokens: 10 } })), undefined)
})

test('routing usage normalizes subset and separate cache counts without changing billing', () => {
  assert.deepEqual(extractRoutingUsage({}, json({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } })), { inputTokens: 100, cachedInputTokens: 80 })
  assert.deepEqual(extractRoutingUsage({}, json({ response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 } } } })), { inputTokens: 100, cachedInputTokens: 80 })
  assert.deepEqual(extractRoutingUsage({}, json({ usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 80 } })), { inputTokens: 110, cachedInputTokens: 80 })
  assert.deepEqual(extractRoutingUsage({}, json({ result: { usage: { input_tokens: 10, cached_input_tokens: 80 } } })), { inputTokens: 90, cachedInputTokens: 80 })
})

test('routing usage collects final streaming usage once, preserving an earlier cache report', () => {
  const events = [
    { message: { usage: { input_tokens: 10, cache_read_input_tokens: 80 } } },
    { usage: { output_tokens: 3 } },
    { usage: { output_tokens: 9 } },
  ]
  const body = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
  assert.deepEqual(extractRoutingUsage({ 'content-type': 'text/event-stream' }, body), { inputTokens: 90, cachedInputTokens: 80 })
  assert.deepEqual(extractRoutingUsage({}, body), { inputTokens: 90, cachedInputTokens: 80 })
  const completed = Buffer.from(`event: response.completed\r\ndata: ${JSON.stringify({ response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 } } } })}\r\n\r\n`)
  assert.deepEqual(extractRoutingUsage({}, completed), { inputTokens: 100, cachedInputTokens: 80 })
})

test('routing usage rejects error streams, malformed counters, and coercion', () => {
  for (const usage of [
    { prompt_tokens: '10' }, { prompt_tokens: -1 }, { prompt_tokens: 1.5 },
    { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: null } },
    { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 } },
    { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1 },
  ]) assert.equal(extractRoutingUsage({}, json({ usage })), undefined)
  const body = Buffer.from('data: {"usage":{"prompt_tokens":10}}\n\ndata: {"type":"error","error":{"message":"interrupted"}}\n\n')
  assert.equal(extractRoutingUsage({}, body), undefined)
  assert.equal(extractRoutingUsage({}, json({ type: 'response.incomplete', response: { usage: { input_tokens: 10 } } })), undefined)
  assert.equal(extractRoutingUsage({}, Buffer.from('{broken')), undefined)
})
