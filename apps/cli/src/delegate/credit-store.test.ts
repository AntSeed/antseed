import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DelegateCreditsAccrual } from '@antseed/node'
import { CreditStore } from './credit-store.js'

const VERIFIER = '0x' + '11'.repeat(20)
const BUYER = '0x' + '22'.repeat(20)
const COMMIT_A = '0x' + 'aa'.repeat(32)
const COMMIT_B = '0x' + 'bb'.repeat(32)

function accrual(overrides?: Partial<DelegateCreditsAccrual>): DelegateCreditsAccrual {
  return {
    verifier: VERIFIER,
    probeCommitment: COMMIT_A,
    buyer: BUYER,
    agentId: 7,
    serviceHash: '0x' + 'cc'.repeat(32),
    credits: 3,
    blockNumber: 100,
    ...overrides,
  }
}

async function withStore(fn: (store: CreditStore, path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'antseed-credit-store-'))
  try {
    await fn(new CreditStore(join(root, 'credits.json')), join(root, 'credits.json'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('a fresh store reports a zero cursor and no accruals', async () => {
  await withStore(async (store) => {
    assert.equal(await store.getCursor(), 0)
    assert.deepEqual(await store.list(), [])
  })
})

test('recordScan persists accruals, advances the cursor, and dedupes by (verifier, commitment, buyer)', async () => {
  await withStore(async (store) => {
    const added = await store.recordScan([accrual(), accrual({ probeCommitment: COMMIT_B, blockNumber: 101 })], 101)
    assert.equal(added, 2)
    assert.equal(await store.getCursor(), 101)

    // Re-scanning the same triple refreshes its credits/block but adds nothing.
    const addedAgain = await store.recordScan([accrual({ credits: 9, blockNumber: 150 })], 150)
    assert.equal(addedAgain, 0)
    assert.equal(await store.getCursor(), 150)

    const list = await store.list()
    assert.equal(list.length, 2)
    const refreshed = list.find((a) => a.probeCommitment === COMMIT_A)!
    assert.equal(refreshed.credits, 9)
    assert.equal(refreshed.blockNumber, 150)
    // Sorted newest block first.
    assert.equal(list[0]!.probeCommitment, COMMIT_A)
  })
})

test('the cursor never goes backwards on an out-of-order scan', async () => {
  await withStore(async (store) => {
    await store.recordScan([], 200)
    await store.recordScan([], 50)
    assert.equal(await store.getCursor(), 200)
  })
})

test('state survives a fresh store instance (durable JSON on disk)', async () => {
  await withStore(async (store, path) => {
    await store.recordScan([accrual()], 100)
    const reopened = new CreditStore(path)
    assert.equal(await reopened.getCursor(), 100)
    assert.equal((await reopened.list()).length, 1)
    // The file is valid JSON with the documented shape.
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { version: number; cursorBlock: number }
    assert.equal(parsed.version, 1)
    assert.equal(parsed.cursorBlock, 100)
  })
})
