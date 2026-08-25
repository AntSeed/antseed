import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractConversationIdentity,
  extractFirstUserSnippet,
  isCompletionRequestPath,
  isTitleGenerationRequest,
} from './conversation-identity.js'

const CURSOR_ENVIRONMENT = `OS Version: darwin 25.2.0
Shell: zsh
Workspace Path: unknown
Is directory a git repo: No
Today's Date: August 25, 2026`

test('isCompletionRequestPath matches API turn endpoints', () => {
  assert.equal(isCompletionRequestPath('/v1/messages'), true)
  assert.equal(isCompletionRequestPath('/v1/messages?beta=true'), true)
  assert.equal(isCompletionRequestPath('/v1/chat/completions'), true)
  assert.equal(isCompletionRequestPath('/v1/completions'), true)
  assert.equal(isCompletionRequestPath('/v1/responses'), true)
  assert.equal(isCompletionRequestPath('/v1/models'), false)
  assert.equal(isCompletionRequestPath('/_antseed/route'), false)
})

test('claude code identity comes from x-claude-code-session-id', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'claude-cli/2.1.216 (external, sdk-cli)',
    'x-claude-code-session-id': '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
  }, null)
  assert.deepEqual(identity, {
    tool: 'claude-code',
    sessionKey: '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
    parentSessionKey: null,
    isUserThread: true,
  })
})

test('system proxy source profile wins over SDK client identity for intercepted traffic', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'claude-cli/2.1.216 (external, sdk-cli)',
    'x-antseed-system-proxy-source': 'custom-api-anthropic-com',
    'x-claude-code-session-id': '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
  }, null)
  assert.deepEqual(identity, {
    tool: 'custom-api-anthropic-com',
    sessionKey: '43ddc5e7-0b8e-491f-a5d1-f2a6854f689d',
    parentSessionKey: null,
    isUserThread: true,
  })
})

test('turn metadata marks a tool-opened thread as not a user chat', () => {
  const meta = (threadSource: string): string => JSON.stringify({
    thread_id: '019f9adc-ad46-7ba1-bdfc-b9612c116462',
    request_kind: 'turn',
    thread_source: threadSource,
  })
  const headers = (turnMetadata: string): Record<string, string> => ({
    'originator': 'Codex Desktop',
    'thread-id': '019f9adc-ad46-7ba1-bdfc-b9612c116462',
    'x-codex-turn-metadata': turnMetadata,
  })
  // Codex titles a new chat from a system thread of its own.
  assert.equal(extractConversationIdentity(headers(meta('system')), null)?.isUserThread, false)
  assert.equal(extractConversationIdentity(headers(meta('user')), null)?.isUserThread, true)
  // Missing, unparseable or silent metadata is taken as a user chat.
  assert.equal(extractConversationIdentity(headers('{not json'), null)?.isUserThread, true)
  assert.equal(extractConversationIdentity(headers('{}'), null)?.isUserThread, true)
  assert.equal(extractConversationIdentity({ 'thread-id': 't1' }, null)?.isUserThread, true)
})

test('user-agent product token identifies the tool generically', () => {
  const identity = extractConversationIdentity(
    { 'user-agent': 'claude-cli/2.1.216 (external, sdk-cli)' },
    { metadata: { user_id: JSON.stringify({ device_id: 'abc', session_id: 'sess-123' }) } },
  )
  assert.equal(identity?.tool, 'claude-cli')
  assert.equal(identity?.sessionKey, 'sess-123')
})

test('originator header names the client and thread-id wins as session key', () => {
  const identity = extractConversationIdentity({
    'originator': 'codex_exec',
    'user-agent': 'codex_exec/0.138.0 (Mac OS 26.2.0; arm64)',
    'session-id': '019f83b7-0e98-7bc0-9d74-afd5e8844b76',
    'thread-id': '019f83b7-0e98-7bc0-9d74-afd5e8844b76',
  }, null)
  assert.equal(identity?.tool, 'codex-exec')
  assert.equal(identity?.sessionKey, '019f83b7-0e98-7bc0-9d74-afd5e8844b76')
})

test('prompt_cache_key body field works as the session key fallback', () => {
  const identity = extractConversationIdentity(
    { 'user-agent': 'codex_exec/0.138.0' },
    { prompt_cache_key: '019f83b8-2914-7c90-94e6-3b5fc34335cd' },
  )
  assert.equal(identity?.tool, 'codex-exec')
  assert.equal(identity?.sessionKey, '019f83b8-2914-7c90-94e6-3b5fc34335cd')
})

test('opencode identity uses x-session-id and carries the parent session', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'opencode/1.2.3',
    'x-session-id': 'ses_abc',
    'x-session-affinity': 'ses_abc',
    'x-parent-session-id': 'ses_parent',
  }, null)
  assert.deepEqual(identity, { tool: 'opencode', sessionKey: 'ses_abc', parentSessionKey: 'ses_parent', isUserThread: true })
})

test('any x-<tool>-session-id header identifies the tool generically', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'SomeNewTool/0.1',
    'x-cursor-session-id': 'sess-42',
  }, null)
  assert.deepEqual(identity, { tool: 'cursor', sessionKey: 'sess-42', parentSessionKey: null, isUserThread: true })
})

test('x-parent-session-id is never mistaken for a tool session header', () => {
  const identity = extractConversationIdentity({
    'user-agent': 'opencode/1.0',
    'x-session-id': 'ses_child',
    'x-parent-session-id': 'ses_parent',
  }, null)
  assert.deepEqual(identity, { tool: 'opencode', sessionKey: 'ses_child', parentSessionKey: 'ses_parent', isUserThread: true })
})

test('requests without any identity return null', () => {
  assert.equal(extractConversationIdentity({ 'user-agent': 'curl/8.0' }, { model: 'x' }), null)
  assert.equal(extractConversationIdentity({}, null), null)
})

test('identified clients without a session id get a stable synthetic conversation key', () => {
  const firstRequest = {
    model: 'antseed',
    messages: [
      { role: 'system', content: 'You are Hermes.' },
      { role: 'user', content: 'Refactor the payment service.' },
    ],
  }
  const laterRequest = {
    ...firstRequest,
    messages: [
      ...firstRequest.messages,
      { role: 'assistant', content: 'I will inspect it.' },
      { role: 'user', content: 'Start with the retry logic.' },
    ],
  }
  const first = extractConversationIdentity({ originator: 'hermes' }, firstRequest)
  const later = extractConversationIdentity({ originator: 'hermes' }, laterRequest)
  assert.equal(first?.tool, 'hermes')
  assert.match(first?.sessionKey ?? '', /^synthetic-[0-9a-f]{32}$/)
  assert.equal(later?.sessionKey, first?.sessionKey)
})

test('cursor synthetic conversation keys use the prompt after the environment preamble', () => {
  const headers = {
    'user-agent': 'Cursor/1.0',
    'x-antseed-system-proxy-source': 'cursor',
  }
  const first = extractConversationIdentity(headers, {
    messages: [{ role: 'user', content: `${CURSOR_ENVIRONMENT}\n\nFix the login bug.` }],
  })
  const later = extractConversationIdentity(headers, {
    messages: [
      { role: 'user', content: `${CURSOR_ENVIRONMENT}\n\nFix the login bug.` },
      { role: 'assistant', content: 'I will inspect it.' },
      { role: 'user', content: 'Start with auth.ts.' },
    ],
  })
  assert.match(first?.sessionKey ?? '', /^synthetic-[0-9a-f]{32}$/)
  assert.equal(later?.sessionKey, first?.sessionKey)
})

test('synthetic conversation keys ignore title-only housekeeping requests', () => {
  assert.equal(extractConversationIdentity({ originator: 'hermes' }, {
    messages: [{ role: 'user', content: 'Generate a title for this conversation:' }],
  }), null)
})

test('snippet: anthropic messages with string content', () => {
  const snippet = extractFirstUserSnippet({
    messages: [{ role: 'user', content: 'fix the login bug in auth.ts' }],
  })
  assert.equal(snippet, 'fix the login bug in auth.ts')
})

test('snippet: anthropic messages skip system-reminder blocks', () => {
  const snippet = extractFirstUserSnippet({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>context stuff</system-reminder>' },
        { type: 'text', text: 'actual user question here' },
      ],
    }],
  })
  assert.equal(snippet, 'actual user question here')
})

test('snippet: responses input items skip environment context', () => {
  const snippet = extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] },
    ],
  })
  assert.equal(snippet, 'say hi')
})

test('snippet: cursor environment preamble never becomes the title', () => {
  assert.equal(extractFirstUserSnippet({
    messages: [
      { role: 'user', content: CURSOR_ENVIRONMENT },
      { role: 'user', content: 'Fix the login bug.' },
    ],
  }), 'Fix the login bug.')
  assert.equal(extractFirstUserSnippet({
    messages: [{ role: 'user', content: `${CURSOR_ENVIRONMENT}\n\nFix the login bug.` }],
  }), 'Fix the login bug.')
  assert.equal(extractFirstUserSnippet({
    messages: [{ role: 'user', content: CURSOR_ENVIRONMENT }],
  }), null)
})

test('snippet: responses string input, whitespace collapsed and truncated', () => {
  assert.equal(extractFirstUserSnippet({ input: 'hello\n\n  world' }), 'hello world')
  const long = 'a'.repeat(500)
  const snippet = extractFirstUserSnippet({ input: long })
  assert.ok(snippet !== null && snippet.length <= 80)
  assert.ok(snippet.endsWith('…'))
})

test('snippet: xml-ish tags are stripped from labels', () => {
  assert.equal(
    extractFirstUserSnippet({ messages: [{ role: 'user', content: '<session> try to understand who reviews are from </session>' }] }),
    'try to understand who reviews are from',
  )
  // Pure-markup candidates are passed over in favor of real text.
  assert.equal(
    extractFirstUserSnippet({
      messages: [
        { role: 'user', content: '<context></context>' },
        { role: 'user', content: 'real question' },
      ],
    }),
    'real question',
  )
})

test('snippet: falls back to machine context when nothing else exists', () => {
  const snippet = extractFirstUserSnippet({
    messages: [{ role: 'user', content: '<system-reminder>only this</system-reminder>' }],
  })
  assert.equal(snippet, 'only this')
})

test('snippet: opencode title request surfaces the embedded real prompt', () => {
  // ensureTitle sends [instruction, ...real conversation] on the SAME session.
  const snippet = extractFirstUserSnippet({
    messages: [
      { role: 'user', content: 'Generate a title for this conversation:\n' },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.equal(snippet, 'hi')
})

test('snippet: pure title request yields null, never a label', () => {
  assert.equal(extractFirstUserSnippet({
    messages: [{ role: 'user', content: 'Please write a 5-10 word title for the following conversation:\n\nuser: hello' }],
  }), null)
  assert.equal(extractFirstUserSnippet({
    messages: [{ role: 'user', content: 'Generate a brief title that would help the user find this conversation later.' }],
  }), null)
})

test('snippet: injected project-doc blobs never label a chat', () => {
  // Codex sends AGENTS.md/CLAUDE.md contents as a user message ahead of the
  // real prompt; the doc must be skipped in favor of the genuine turn.
  assert.equal(extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/shahafan/Development/antseed\n\n# CLAUDE.md --...' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the failing tests' }] },
    ],
  }), 'fix the failing tests')
  // A doc-only request yields null instead of falling back to the blob —
  // even when wrapped in a machine-context tag.
  assert.equal(extractFirstUserSnippet({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions># AGENTS.md instructions for /repo ...</user_instructions>' }] },
    ],
  }), null)
})

test('sanitizeStoredSnippet heals stored project-doc labels to empty', async () => {
  const { sanitizeStoredSnippet } = await import('./conversation-identity.js')
  assert.equal(sanitizeStoredSnippet('# AGENTS.md instructions for /Users/shahafan/Development/antseed # CLAUDE.md --…'), '')
  assert.equal(sanitizeStoredSnippet('OS Version: darwin 25.2.0 Shell: zsh Workspace Path: unknown Is directory a git…'), '')
  assert.equal(sanitizeStoredSnippet('fix the login bug'), 'fix the login bug')
})

test('snippet: null for empty or non-conversation bodies', () => {
  assert.equal(extractFirstUserSnippet(null), null)
  assert.equal(extractFirstUserSnippet({ model: 'x' }), null)
  assert.equal(extractFirstUserSnippet({ messages: [{ role: 'assistant', content: 'hi' }] }), null)
})

test('title turns are recognised so they cannot define a chat model', () => {
  // OpenCode's verbatim shape: the instruction is its own leading message and
  // the conversation being titled follows it, on the chat's own session id.
  assert.equal(isTitleGenerationRequest({
    messages: [
      { role: 'user', content: 'Generate a title for this conversation:\n' },
      { role: 'user', content: 'hi' },
    ],
  }), true)
  // Claude Code's phrasing, as a Responses-style item list.
  assert.equal(isTitleGenerationRequest({
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Please write a 5-10 word title for the following conversation' }],
    }],
  }), true)
  // T3 Code's Claude agent title prompt.
  assert.equal(isTitleGenerationRequest({
    messages: [{ role: 'user', content: 'You write concise thread titles for a coding chat.' }],
  }), true)
})

test('real turns are not mistaken for title turns', () => {
  assert.equal(isTitleGenerationRequest({ messages: [{ role: 'user', content: 'hi' }] }), false)
  // Only the leading message counts — a later turn quoting the instruction
  // (it is in the history once titling ran) is still a real turn.
  assert.equal(isTitleGenerationRequest({
    messages: [
      { role: 'user', content: 'fix the failing tests' },
      { role: 'user', content: 'Generate a title for this conversation:' },
    ],
  }), false)
  assert.equal(isTitleGenerationRequest(null), false)
  assert.equal(isTitleGenerationRequest({ model: 'x' }), false)
})
