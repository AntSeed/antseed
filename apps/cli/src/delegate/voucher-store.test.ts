import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DelegateVoucherPayload } from '@antseed/node'
import { VoucherStore } from './voucher-store.js'

function voucher(signature: string): DelegateVoucherPayload {
  return {
    version: 1,
    chainId: 8453,
    registry: '0x' + '11'.repeat(20),
    buyer: '0x' + '22'.repeat(20),
    probeCommitment: '0x' + '33'.repeat(32),
    credits: 2,
    nonce: '12345',
    deadline: 2_000_000_000,
    signature,
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-voucher-store-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('persists vouchers and dedupes redelivery by signature', async () => {
  await withTempDir(async (dir) => {
    const store = new VoucherStore(join(dir, 'vouchers.jsonl'))
    assert.equal(await store.add(voucher('0xsig1'), 'v1'), true)
    assert.equal(await store.add(voucher('0xSIG1'), 'v1'), false) // case-insensitive dedupe
    assert.equal(await store.add(voucher('0xsig2'), 'v1'), true)
    const listed = await store.list()
    assert.equal(listed.length, 2)
  })
})

test('a failed append does NOT suppress redelivery', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'vouchers.jsonl')
    let failNext = true
    const store = new VoucherStore(path, {
      appendFile: (async (target: unknown, data: unknown, encoding: unknown) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        const fs = await import('node:fs/promises')
        return fs.appendFile(target as string, data as string, encoding as BufferEncoding)
      }) as typeof import('node:fs/promises').appendFile,
    })

    await assert.rejects(store.add(voucher('0xsig1'), 'v1'), /disk full/)
    // Redelivery of the SAME voucher must persist now — the signature must
    // not have entered the dedupe set on the failed attempt.
    assert.equal(await store.add(voucher('0xsig1'), 'v1'), true)
    const listed = await store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.signature, '0xsig1')
  })
})

test('concurrent first writes are serialized: no lost entries, no duplicate appends', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'vouchers.jsonl')
    // Slow every fs op so unserialized adds would interleave initialization.
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const fs = await import('node:fs/promises')
    const store = new VoucherStore(path, {
      readFile: (async (...args: Parameters<typeof fs.readFile>) => {
        await delay(10)
        return fs.readFile(...args)
      }) as typeof fs.readFile,
      appendFile: (async (...args: Parameters<typeof fs.appendFile>) => {
        await delay(10)
        return fs.appendFile(...args)
      }) as typeof fs.appendFile,
    })

    const results = await Promise.all([
      store.add(voucher('0xsig1'), 'v1'),
      store.add(voucher('0xsig1'), 'v1'), // duplicate in flight
      store.add(voucher('0xsig2'), 'v1'),
    ])
    assert.deepEqual(results, [true, false, true])

    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    assert.equal(lines.length, 2, 'exactly one line per distinct voucher')
    const listed = await store.list()
    assert.deepEqual(listed.map((v) => v.signature).sort(), ['0xsig1', '0xsig2'])
  })
})
