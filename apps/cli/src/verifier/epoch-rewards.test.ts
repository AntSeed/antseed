import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimRewardEpochs, firstScanEpoch } from './epoch-rewards.js'
import type { EpochRewardSource } from './epoch-rewards.js'

interface EpochFixture {
  credits?: number
  claimed?: boolean
  pending?: bigint
  /** Throw from claim() for this epoch. */
  claimFails?: boolean
}

function source(epochs: Record<number, EpochFixture>, claimedLog: number[] = []): EpochRewardSource {
  return {
    credits: async (epoch) => epochs[epoch]?.credits ?? 0,
    claimed: async (epoch) => epochs[epoch]?.claimed ?? false,
    pending: async (epoch) => epochs[epoch]?.pending ?? 0n,
    claim: async (epoch) => {
      if (epochs[epoch]?.claimFails) throw new Error(`revert epoch ${epoch}`)
      claimedLog.push(epoch)
      return `0xtx${epoch}`
    },
  }
}

test('scans the full claimable window from effectiveEpoch', () => {
  assert.equal(firstScanEpoch({ currentEpoch: 20, effectiveEpoch: 3 }), 3)
  // A resume floor never reaches below the claimable window.
  assert.equal(firstScanEpoch({ currentEpoch: 20, effectiveEpoch: 3 }, 1), 3)
  assert.equal(firstScanEpoch({ currentEpoch: 20, effectiveEpoch: 3 }, 7), 7)
})

test('one reverting epoch does not block claiming a later epoch', async () => {
  const claimedLog: number[] = []
  const errors: number[] = []
  const result = await claimRewardEpochs(
    { currentEpoch: 6, effectiveEpoch: 3 },
    source({
      3: { credits: 2, pending: 100n, claimFails: true },
      4: { credits: 1, pending: 50n },
      5: { credits: 3, pending: 75n },
    }, claimedLog),
    { onEpochError: (epoch) => errors.push(epoch) },
  )
  assert.deepEqual(claimedLog, [4, 5], 'later epochs must still claim')
  assert.deepEqual(result.failedEpochs, [3])
  assert.deepEqual(errors, [3])
  assert.equal(result.claimedEpochs, 2)
  assert.equal(result.claimedTotal, 125n)
})

test('claimed and zero-credit epochs are skipped without a tx', async () => {
  const claimedLog: number[] = []
  const result = await claimRewardEpochs(
    { currentEpoch: 6, effectiveEpoch: 2 },
    source({
      2: { credits: 0 },
      3: { credits: 4, claimed: true },
      4: { credits: 2, pending: 0n }, // pool empty — nothing claimable yet
      5: { credits: 1, pending: 10n },
    }, claimedLog),
  )
  assert.deepEqual(claimedLog, [5])
  assert.equal(result.claimedEpochs, 1)
  assert.deepEqual(result.failedEpochs, [])
})

test('settledThrough advances over contiguous settled epochs and stops at the first unresolved one', async () => {
  const result = await claimRewardEpochs(
    { currentEpoch: 8, effectiveEpoch: 2 },
    source({
      2: { credits: 0 },
      3: { credits: 1, claimed: true },
      4: { credits: 2, pending: 100n },
      5: { credits: 2, pending: 100n, claimFails: true }, // unresolved — floor stops here
      6: { credits: 0 },
      7: { credits: 1, pending: 5n },
    }),
  )
  assert.equal(result.settledThrough, 5, 'floor must not skip past a failed epoch')
  assert.equal(result.claimedEpochs, 2) // epochs 4 and 7
  assert.deepEqual(result.failedEpochs, [5])

  // A later pass resuming from the floor retries the failed epoch.
  const retryLog: number[] = []
  const retry = await claimRewardEpochs(
    { currentEpoch: 8, effectiveEpoch: 2 },
    source({
      4: { credits: 2, claimed: true },
      5: { credits: 2, pending: 100n },
      7: { credits: 1, claimed: true },
    }, retryLog),
    { fromEpoch: result.settledThrough },
  )
  assert.deepEqual(retryLog, [5])
  assert.equal(retry.settledThrough, 8)
})

test('an empty window claims nothing', async () => {
  const result = await claimRewardEpochs({ currentEpoch: 3, effectiveEpoch: 3 }, source({}))
  assert.equal(result.claimedEpochs, 0)
  assert.equal(result.settledThrough, 3)
})
