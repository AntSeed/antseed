import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadUsedProbeIds, recordUsedProbeIds } from './probe-log.js'

const NOW = '2026-07-04T00:00:00.000Z'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-probe-log-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('missing log reads as an empty set', async () => {
  await withTempDir(async (dir) => {
    const ids = await loadUsedProbeIds(dir, 'kimi-k2')
    assert.equal(ids.size, 0)
  })
})

test('records and reloads used ids per service', async () => {
  await withTempDir(async (dir) => {
    await recordUsedProbeIds(dir, 'kimi-k2', ['comp:a', 'comp:b'], 100, NOW)
    const ids = await loadUsedProbeIds(dir, 'kimi-k2')
    assert.deepEqual([...ids].sort(), ['comp:a', 'comp:b'])
    // Different service is isolated.
    assert.equal((await loadUsedProbeIds(dir, 'deepseek')).size, 0)
  })
})

test('appends across rounds and de-dupes re-added ids', async () => {
  await withTempDir(async (dir) => {
    await recordUsedProbeIds(dir, 's', ['a', 'b'], 100, NOW)
    await recordUsedProbeIds(dir, 's', ['b', 'c'], 100, NOW)
    const ids = await loadUsedProbeIds(dir, 's')
    assert.deepEqual([...ids].sort(), ['a', 'b', 'c'])
  })
})

test('ring buffer keeps only the most recent `cap` ids', async () => {
  await withTempDir(async (dir) => {
    await recordUsedProbeIds(dir, 's', ['a', 'b', 'c'], 3, NOW)
    await recordUsedProbeIds(dir, 's', ['d', 'e'], 3, NOW)
    const ids = await loadUsedProbeIds(dir, 's')
    // a, b fell off the front; c, d, e remain.
    assert.deepEqual([...ids].sort(), ['c', 'd', 'e'])
  })
})

test('empty id list is a no-op', async () => {
  await withTempDir(async (dir) => {
    await recordUsedProbeIds(dir, 's', [], 10, NOW)
    assert.equal((await loadUsedProbeIds(dir, 's')).size, 0)
  })
})

test('dot-only service names never touch the filesystem', async () => {
  await withTempDir(async (dir) => {
    // ".." would write the log one directory up.
    await assert.rejects(recordUsedProbeIds(dir, '..', ['a'], 10, NOW), /unsafe service name/)
    // Reads treat it like any other failure: empty set, no crash.
    assert.equal((await loadUsedProbeIds(dir, '..')).size, 0)
  })
})
