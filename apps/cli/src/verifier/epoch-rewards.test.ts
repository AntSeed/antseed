import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimRewardEpochs,
  firstScanEpoch,
  verifierRewardSource,
} from './epoch-rewards.js'

test('firstScanEpoch never scans before the rewards effective epoch', () => {
  const window = { currentEpoch: 10n, effectiveEpoch: 4n }
  assert.equal(firstScanEpoch(window), 4n)
  assert.equal(firstScanEpoch(window, 2n), 4n)
  assert.equal(firstScanEpoch(window, 7n), 7n)
})

test('claimRewardEpochs claims pending rewards and advances only through contiguous settled epochs', async () => {
  const claimed: bigint[] = []
  const errors: bigint[] = []
  const result = await claimRewardEpochs(
    { currentEpoch: 8n, effectiveEpoch: 3n },
    {
      credits: async (epoch) => {
        if (epoch === 6n) throw new Error('rpc unavailable')
        return epoch === 4n || epoch === 7n ? 2n : 0n
      },
      pending: async (epoch) => epoch === 4n ? 25n : 0n,
      claim: async (epoch) => {
        claimed.push(epoch)
        return `tx-${epoch}`
      },
    },
    { onEpochError: (epoch) => errors.push(epoch) },
  )

  assert.deepEqual(claimed, [4n])
  assert.deepEqual(errors, [6n])
  assert.equal(result.claimedTotal, 25n)
  assert.equal(result.claimedEpochs, 1)
  assert.deepEqual(result.failedEpochs, [6n])
  assert.equal(result.settledThrough, 6n)
})

test('verifierRewardSource binds verifier address and signer to the verification contract', async () => {
  const calls: unknown[][] = []
  const signer = { label: 'signer' }
  const source = verifierRewardSource(
    {
      epochCredits: async (...args: unknown[]) => { calls.push(['credits', ...args]); return 3n },
      pendingVerifierReward: async (...args: unknown[]) => { calls.push(['pending', ...args]); return 9n },
      claimVerifierReward: async (...args: unknown[]) => { calls.push(['claim', ...args]); return '0xtx' },
    },
    '0xverifier',
    signer as never,
  )
  assert.equal(await source.credits(7n), 3n)
  assert.equal(await source.pending(7n), 9n)
  assert.equal(await source.claim(7n), '0xtx')
  assert.deepEqual(calls, [
    ['credits', 7n, '0xverifier'],
    ['pending', 7n, '0xverifier'],
    ['claim', signer, 7n],
  ])
})
