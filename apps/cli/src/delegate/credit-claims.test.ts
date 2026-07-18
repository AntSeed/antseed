import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AbstractSigner } from 'ethers'
import type { StoredCreditAccrual } from './credit-store.js'
import {
  claimDelegateCredits,
  resolveCreditStatuses,
  type CreditAccrualReader,
} from './credit-claims.js'

const VERIFIER = '0x' + '11'.repeat(20)
const BUYER = '0x' + '22'.repeat(20)
const COMMITMENT = '0x' + 'aa'.repeat(32)

function accrual(overrides?: Partial<StoredCreditAccrual>): StoredCreditAccrual {
  return {
    verifier: VERIFIER,
    probeCommitment: COMMITMENT,
    buyer: BUYER,
    agentId: 7,
    serviceHash: '0x' + 'cc'.repeat(32),
    credits: 5,
    blockNumber: 100,
    firstSeenAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

function reader(accrued: number, claimed: number): CreditAccrualReader {
  return {
    commitmentDelegateAccrued: async () => accrued,
    commitmentDelegateClaimed: async () => claimed,
  }
}

test('resolveCreditStatuses computes claimable = accrued - claimed and the state', async () => {
  const [claimable] = await resolveCreditStatuses([accrual()], reader(5, 2))
  assert.equal(claimable!.accrued, 5)
  assert.equal(claimable!.claimed, 2)
  assert.equal(claimable!.claimable, 3)
  assert.equal(claimable!.state, 'claimable')

  const [fullyClaimed] = await resolveCreditStatuses([accrual()], reader(5, 5))
  assert.equal(fullyClaimed!.claimable, 0)
  assert.equal(fullyClaimed!.state, 'claimed')

  const [empty] = await resolveCreditStatuses([accrual()], reader(0, 0))
  assert.equal(empty!.state, 'empty')
})

test('resolveCreditStatuses falls back to last-seen credits when a read fails', async () => {
  const failing: CreditAccrualReader = {
    commitmentDelegateAccrued: async () => { throw new Error('rpc down') },
    commitmentDelegateClaimed: async () => 0,
  }
  const warnings: string[] = []
  const [status] = await resolveCreditStatuses([accrual({ credits: 7 })], failing, { warn: (m) => warnings.push(m) })
  assert.equal(status!.accrued, 7)
  assert.equal(status!.state, 'claimable')
  assert.equal(warnings.length, 1)
})

test('resolveCreditStatuses with no reader treats accruals as claimable at last-seen credits', async () => {
  const [status] = await resolveCreditStatuses([accrual({ credits: 4 })], null)
  assert.equal(status!.accrued, 4)
  assert.equal(status!.state, 'claimable')
})

test('claimDelegateCredits claims only claimable accruals, one tx each, passing the triple', async () => {
  const submitted: Array<{ verifier: string; probeCommitment: string; buyer: string }> = []
  const registry = {
    claimDelegateCredits: async (_signer: AbstractSigner, input: { verifier: string; probeCommitment: string; buyer: string }) => {
      submitted.push(input)
      return '0x' + 'ab'.repeat(32)
    },
  }
  const statuses = await resolveCreditStatuses(
    [
      accrual({ probeCommitment: '0x' + 'a1'.repeat(32) }),
      accrual({ probeCommitment: '0x' + 'a2'.repeat(32) }),
    ],
    {
      commitmentDelegateAccrued: async (_v, commitment) => (commitment.startsWith('0x' + 'a1') ? 5 : 5),
      commitmentDelegateClaimed: async (_v, commitment) => (commitment.startsWith('0x' + 'a1') ? 0 : 5),
    },
  )
  const result = await claimDelegateCredits({
    statuses,
    registry,
    signer: {} as AbstractSigner,
  })
  assert.equal(result.claimedCount, 1)
  assert.equal(result.claimedCredits, 5)
  assert.equal(result.skippedClaimed, 1)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]!.probeCommitment, '0x' + 'a1'.repeat(32))
  assert.equal(submitted[0]!.verifier, VERIFIER)
  assert.equal(submitted[0]!.buyer, BUYER)
})

test('claimDelegateCredits isolates per-accrual failures', async () => {
  const registry = {
    claimDelegateCredits: async () => { throw new Error('NothingToClaim') },
  }
  const statuses = await resolveCreditStatuses([accrual()], reader(5, 0))
  const errors: string[] = []
  const result = await claimDelegateCredits({
    statuses,
    registry,
    signer: {} as AbstractSigner,
    onError: (_s, err) => errors.push(err.message),
  })
  assert.equal(result.failed, 1)
  assert.equal(result.claimedCount, 0)
  assert.equal(errors.length, 1)
})
