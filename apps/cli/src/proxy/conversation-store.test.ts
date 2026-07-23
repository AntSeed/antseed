import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationStore, CONVERSATIONS_FILE, conversationId } from './conversation-store.js'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'antseed-conv-'))
}

test('touch creates a conversation and keeps the original snippet', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const created = store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'first prompt' })
    assert.equal(created.id, 'codex:s1')
    assert.equal(created.snippet, 'first prompt')
    assert.equal(created.pinnedModel, null)

    const touched = store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'second prompt', lastModel: 'a'.repeat(40) + '@gpt-5.4' })
    assert.equal(touched.snippet, 'first prompt')
    assert.equal(touched.lastModel, 'a'.repeat(40) + '@gpt-5.4')
    assert.ok(touched.lastActiveAt >= created.lastActiveAt)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('first resolved model becomes the pin and later touches never replace it', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const firstModel = 'a'.repeat(40) + '@gpt-5.4'
    const laterModel = 'b'.repeat(40) + '@glm-5'

    // Created without a resolved model (e.g. a title request): no pin yet.
    const created = store.touch({ tool: 'codex', sessionKey: 's1' })
    assert.equal(created.pinnedModel, null)

    // The first request that resolves a model pins the chat to it.
    const pinned = store.touch({ tool: 'codex', sessionKey: 's1', lastModel: firstModel })
    assert.equal(pinned.pinnedModel, firstModel)

    // A later request served by a different route (default changed) keeps
    // the original pin — the default only steers chats that haven't started.
    const touched = store.touch({ tool: 'codex', sessionKey: 's1', lastModel: laterModel })
    assert.equal(touched.pinnedModel, firstModel)
    assert.equal(touched.lastModel, laterModel)

    // A brand-new chat pins to its first model immediately.
    const fresh = store.touch({ tool: 'codex', sessionKey: 's2', lastModel: laterModel })
    assert.equal(fresh.pinnedModel, laterModel)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('persists to conversations.json and reloads across instances', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'opencode', sessionKey: 'ses_a', snippet: 'hello there' })
    store.setLabel(conversationId('opencode', 'ses_a'), '  My   renamed chat  ')
    store.setPinnedModel(conversationId('opencode', 'ses_a'), 'b'.repeat(40) + '@glm-5')
    await store.flush()

    const raw = JSON.parse(await readFile(join(dir, CONVERSATIONS_FILE), 'utf8')) as { conversations: unknown[] }
    assert.equal(raw.conversations.length, 1)

    const reloaded = new ConversationStore(dir)
    const record = reloaded.get('opencode:ses_a')
    assert.ok(record)
    assert.equal(record.label, 'My renamed chat')
    assert.equal(record.snippet, 'hello there')
    assert.equal(reloaded.getPinnedModel('opencode', 'ses_a'), 'b'.repeat(40) + '@glm-5')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('label can be cleared and pin can be cleared', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'claude-code', sessionKey: 'k1' })
    const id = conversationId('claude-code', 'k1')
    store.setLabel(id, 'named')
    store.setPinnedModel(id, 'c'.repeat(40) + '@claude-opus-4-8')
    assert.equal(store.setLabel(id, null)?.label, null)
    assert.equal(store.setPinnedModel(id, null)?.pinnedModel, null)
    assert.equal(store.setLabel('unknown:id', 'x'), null)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('remove deletes the record; a later touch recreates it fresh', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'old snippet' })
    assert.equal(store.remove('codex:s1'), true)
    assert.equal(store.remove('codex:s1'), false)
    assert.equal(store.get('codex:s1'), null)

    const recreated = store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'new snippet' })
    assert.equal(recreated.snippet, 'new snippet')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prunes beyond the LRU cap, keeping the most recently active', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    for (let i = 0; i < 60; i += 1) {
      store.touch({ tool: 'codex', sessionKey: `s${i}` })
    }
    const listed = store.list()
    assert.equal(listed.length, 50)
    // The earliest-touched sessions are the ones evicted.
    assert.equal(store.get('codex:s59') !== null, true)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('list returns newest activity first', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'codex', sessionKey: 'older' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.touch({ tool: 'codex', sessionKey: 'newer' })
    const [first] = store.list()
    assert.equal(first?.sessionKey, 'newer')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('survives a corrupted file by starting clean', async () => {
  const dir = await makeDir()
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, CONVERSATIONS_FILE), 'not json at all', 'utf8')
    const store = new ConversationStore(dir)
    assert.deepEqual(store.list(), [])
    store.touch({ tool: 'codex', sessionKey: 's1' })
    await store.flush()
    const reloaded = new ConversationStore(dir)
    assert.equal(reloaded.list().length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reload re-cleans snippets persisted by older extraction rules', async () => {
  const dir = await makeDir()
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, CONVERSATIONS_FILE), JSON.stringify({
      conversations: [
        {
          tool: 'claude-code', sessionKey: 'old1',
          snippet: '<session> try to understand who reviews are from </session> and more text',
          createdAt: Date.now(), lastActiveAt: Date.now(),
        },
        {
          tool: 'opencode', sessionKey: 'old2',
          snippet: 'Generate a title for this conversation:',
          createdAt: Date.now(), lastActiveAt: Date.now(),
        },
      ],
    }), 'utf8')
    const store = new ConversationStore(dir)
    assert.equal(store.get('claude-code:old1')?.snippet, 'try to understand who reviews are from and more text')
    // Old title-request snippets are dropped so the next real turn names the chat.
    assert.equal(store.get('opencode:old2')?.snippet, '')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
