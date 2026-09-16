import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoutingLog } from './routing-log.js'

test('routing logs serialize concurrent records and rotate within bounded storage', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-log-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const log = new RoutingLog(directory, 150)
  await Promise.all(Array.from({ length: 20 }, (_, index) => log.record({ index, trigger: 'new-turn' })))
  await log.flush()
  assert.deepEqual((await readdir(directory)).sort(), ['routing-operations.jsonl', 'routing-operations.jsonl.1'])
  for (const file of await readdir(directory)) {
    assert.ok((await stat(join(directory, file))).size <= 150)
    const records = (await readFile(join(directory, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(records.every((record) => typeof record.index === 'number'))
  }
  assert.equal((await stat(join(directory, 'routing-operations.jsonl'))).mode & 0o777, 0o600)
})

test('oversized records and a failed disk write do not poison the logging queue', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-log-failure-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const log = new RoutingLog(directory, 100)
  await assert.rejects(log.record({ large: 'x'.repeat(100) }), /capacity/)
  const blocked = join(directory, 'routing-operations.jsonl')
  await mkdir(blocked)
  await assert.rejects(log.record({ outcome: 'blocked' }))
  await rm(blocked, { recursive: true })
  await log.record({ outcome: 'recovered' })
  assert.match(await readFile(blocked, 'utf8'), /recovered/)
})

test('the first rotation also bounds an oversized pre-existing log', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-log-upgrade-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'routing-operations.jsonl')
  await writeFile(file, `${JSON.stringify({ old: true })}\n`.repeat(100))
  await new RoutingLog(directory, 100).record({ new: true })
  assert.ok((await stat(`${file}.1`)).size <= 100)
  for (const line of (await readFile(`${file}.1`, 'utf8')).trim().split('\n')) assert.equal(JSON.parse(line).old, true)
})

test('queue overload rejects without dropping already accepted records', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-log-overload-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const log = new RoutingLog(directory)
  const writes = Array.from({ length: 1000 }, (_, index) => log.record({ index }))
  await assert.rejects(log.record({ index: 1000 }), /capacity/)
  await Promise.all(writes)
  await log.record({ index: 1001 })
  await log.flush()
  const records = (await readFile(join(directory, 'routing-operations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(records.length, 1001)
  assert.equal(records.at(-1).index, 1001)
})
