import assert from 'node:assert/strict'
import test from 'node:test'
import { ConcurrencyLimiter, KeyedSerialLimiter, mapConcurrently } from './audit-concurrency.js'

test('concurrency limiter bounds active tasks', async () => {
  const limiter = new ConcurrencyLimiter(3)
  let active = 0
  let maximum = 0
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
  })))
  assert.equal(maximum, 3)
})

test('keyed limiter serializes equal keys but overlaps different keys', async () => {
  const limiter = new KeyedSerialLimiter()
  const active = new Map<string, number>()
  let sameKeyMaximum = 0
  let totalActive = 0
  let totalMaximum = 0
  await Promise.all(['seller-a', 'seller-a', 'seller-b'].map((key) => limiter.run(key, async () => {
    active.set(key, (active.get(key) ?? 0) + 1)
    sameKeyMaximum = Math.max(sameKeyMaximum, active.get(key)!)
    totalActive += 1
    totalMaximum = Math.max(totalMaximum, totalActive)
    await new Promise((resolve) => setTimeout(resolve, 5))
    totalActive -= 1
    active.set(key, active.get(key)! - 1)
  })))
  assert.equal(sameKeyMaximum, 1)
  assert.equal(totalMaximum, 2)
})

test('concurrent mapping preserves input order', async () => {
  const results = await mapConcurrently([3, 1, 2], 3, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value))
    return value * 2
  })
  assert.deepEqual(results, [6, 2, 4])
})
