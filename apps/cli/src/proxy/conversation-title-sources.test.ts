import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createIntegrationConversationTitleResolver } from './conversation-title-sources.js'

test('Codex titles come from the live session index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-codex-titles-'))
  const indexFile = join(dir, 'session_index.jsonl')
  try {
    await writeFile(indexFile, [
      JSON.stringify({ id: 'thread-1', thread_name: 'Fix the model picker' }),
      '{malformed',
      JSON.stringify({ id: 'thread-2', thread_name: '  Review   the PR  ' }),
    ].join('\n'), 'utf8')
    const resolve = createIntegrationConversationTitleResolver({ codexSessionIndexFile: indexFile })

    assert.equal(resolve('codex-desktop', 'thread-1'), 'Fix the model picker')
    assert.equal(resolve('codex-desktop', 'thread-2'), 'Review the PR')
    assert.equal(resolve('droid', 'thread-1'), null)

    await writeFile(indexFile, JSON.stringify({
      id: 'thread-1',
      thread_name: 'Fix the model picker and sidebar title',
    }), 'utf8')
    assert.equal(resolve('codex-desktop', 'thread-1'), 'Fix the model picker and sidebar title')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing Codex session index falls back safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-codex-titles-'))
  try {
    const resolve = createIntegrationConversationTitleResolver({
      codexSessionIndexFile: join(dir, 'missing.jsonl'),
    })
    assert.equal(resolve('codex-desktop', 'unknown'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
