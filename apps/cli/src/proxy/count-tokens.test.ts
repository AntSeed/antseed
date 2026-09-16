import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateAnthropicPromptTokens, isCountTokensPath } from './count-tokens.js'

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

test('isCountTokensPath matches only the token-count endpoint', () => {
  assert.equal(isCountTokensPath('/v1/messages/count_tokens'), true)
  assert.equal(isCountTokensPath('/v1/messages/count_tokens?beta=true'), true)
  assert.equal(isCountTokensPath('/v1/messages/count_tokens/'), true)
  assert.equal(isCountTokensPath('/v1/messages'), false)
  assert.equal(isCountTokensPath('/v1/messages/batches'), false)
  assert.equal(isCountTokensPath('/v1/chat/completions'), false)
})

test('estimate counts system, tools and the whole message history', () => {
  const words = 'sentinel '.repeat(200).trim()
  const systemOnly = estimateAnthropicPromptTokens(encode({
    model: 'claude-sonnet-4-5',
    system: words,
    messages: [{ role: 'user', content: 'hi' }],
  }))
  const withHistory = estimateAnthropicPromptTokens(encode({
    model: 'claude-sonnet-4-5',
    system: words,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: words }] },
      { role: 'user', content: 'and now?' },
    ],
  }))
  const withTools = estimateAnthropicPromptTokens(encode({
    model: 'claude-sonnet-4-5',
    system: words,
    tools: [{ name: 'Read', description: words, input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }))

  assert.ok(systemOnly > 100, `expected a real count, got ${systemOnly}`)
  assert.ok(withHistory > systemOnly * 1.8, `history must be counted: ${withHistory} vs ${systemOnly}`)
  assert.ok(withTools > systemOnly * 1.8, `tools must be counted: ${withTools} vs ${systemOnly}`)
})

test('estimate reads array system blocks and tool traffic', () => {
  const tokens = estimateAnthropicPromptTokens(encode({
    system: [
      { type: 'text', text: 'You are a CLI assistant.' },
      { type: 'text', text: 'Policy text. '.repeat(50), cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'package.json' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents here' }] },
    ],
  }))
  assert.ok(tokens > 50, `expected blocks to be counted, got ${tokens}`)
})

test('estimate is zero for a body with no prompt text', () => {
  assert.equal(estimateAnthropicPromptTokens(encode({ model: 'claude-sonnet-4-5' })), 0)
  assert.equal(estimateAnthropicPromptTokens(new TextEncoder().encode('not json')), 0)
})
