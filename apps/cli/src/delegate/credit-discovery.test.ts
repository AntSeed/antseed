import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverDelegateAccruals } from './credit-discovery.js'

test('a quiet accrual scan advances to the fixed chain head', async () => {
  const calls: Array<{ buyer: string; fromBlock: number | 'earliest'; toBlock: number | 'latest' }> = []
  const reader = {
    provider: { getBlockNumber: async () => 550 },
    queryDelegateCreditsAccrued: async (
      buyer: string,
      fromBlock?: number | 'earliest',
      toBlock?: number | 'latest',
    ) => {
      calls.push({ buyer, fromBlock: fromBlock ?? 'earliest', toBlock: toBlock ?? 'latest' })
      return []
    },
  }

  assert.deepEqual(await discoverDelegateAccruals(reader, '0xabc', 501), { accruals: [], toBlock: 550 })
  assert.deepEqual(calls, [{ buyer: '0xabc', fromBlock: 501, toBlock: 550 }])
})
