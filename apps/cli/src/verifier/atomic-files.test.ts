import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquirePidFileLock } from './atomic-files.js'

test('PID locks reject live owners and recover stale owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-lock-'))
  const path = join(directory, 'run.lock')
  try {
    const lock = await acquirePidFileLock(path)
    await assert.rejects(acquirePidFileLock(path), /already active/)
    await lock.release()
    await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }))
    const recovered = await acquirePidFileLock(path)
    const current = JSON.parse(await readFile(path, 'utf8')) as { pid: number }
    assert.equal(current.pid, process.pid)
    await recovered.release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
