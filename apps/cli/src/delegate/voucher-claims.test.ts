import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet, recoverAddress } from 'ethers'
import { makeVerifierRegistryDomain, signDelegateVoucher } from '@antseed/node'
import type { DelegateVoucherMessage } from '@antseed/node'
import type { StoredDelegateVoucher } from './voucher-store.js'
import {
  claimDelegateVouchers,
  resolveVoucherStatuses,
  toVoucherMessage,
  voucherDigest,
} from './voucher-claims.js'
import type { VoucherClaimedReader, VoucherStatus } from './voucher-claims.js'

const CHAIN_ID = 8453
const REGISTRY = '0x' + '11'.repeat(20)
const BUYER = '0x' + '22'.repeat(20)

const verifierWallet = Wallet.createRandom()
const VERIFIER_PEER_ID = verifierWallet.address.slice(2).toLowerCase()

async function signedVoucher(overrides: Partial<StoredDelegateVoucher> = {}): Promise<StoredDelegateVoucher> {
  const base = {
    version: 1 as const,
    chainId: CHAIN_ID,
    registry: REGISTRY,
    buyer: BUYER,
    probeCommitment: '0x' + 'ab'.repeat(32),
    credits: 3,
    nonce: '12345',
    deadline: Math.floor(Date.now() / 1000) + 3600,
    verifierPeerId: VERIFIER_PEER_ID,
    receivedAt: new Date().toISOString(),
    ...overrides,
  }
  const signature = overrides.signature ?? await signDelegateVoucher(
    verifierWallet,
    makeVerifierRegistryDomain(base.chainId, base.registry),
    toVoucherMessage(base),
  )
  return { ...base, signature }
}

test('voucherDigest is the exact EIP-712 digest the verifier signed', async () => {
  const voucher = await signedVoucher()
  // Recovering the signer from the digest + signature proves the digest is
  // byte-identical to what the contract's replay guard is keyed on.
  assert.equal(recoverAddress(voucherDigest(voucher), voucher.signature), verifierWallet.address)
})

test('resolveVoucherStatuses classifies claimable, claimed, and expired vouchers', async () => {
  const claimable = await signedVoucher({ nonce: '1' })
  const claimed = await signedVoucher({ nonce: '2' })
  const expired = await signedVoucher({ nonce: '3', deadline: Math.floor(Date.now() / 1000) - 60 })
  const claimedDigest = voucherDigest(claimed)
  const reader: VoucherClaimedReader = {
    voucherClaimed: async (registry, verifier, digest) => {
      assert.equal(registry, REGISTRY)
      assert.equal(verifier.toLowerCase(), verifierWallet.address.toLowerCase())
      return digest === claimedDigest
    },
  }

  const statuses = await resolveVoucherStatuses([claimable, claimed, expired], reader)
  assert.deepEqual(statuses.map((s) => s.state), ['claimable', 'claimed', 'expired'])
  assert.equal(statuses[0]!.verifier.toLowerCase(), verifierWallet.address.toLowerCase())
})

test('without a reader (or on a failed read) an unexpired voucher lists as claimable', async () => {
  const voucher = await signedVoucher()
  const offline = await resolveVoucherStatuses([voucher], null)
  assert.equal(offline[0]!.state, 'claimable')

  const warnings: string[] = []
  const failing: VoucherClaimedReader = {
    voucherClaimed: async () => { throw new Error('rpc down') },
  }
  const degraded = await resolveVoucherStatuses([voucher], failing, { warn: (m) => warnings.push(m) })
  assert.equal(degraded[0]!.state, 'claimable')
  assert.equal(warnings.length, 1)
})

test('claimDelegateVouchers claims claimable vouchers and skips the rest', async () => {
  const claimable = await signedVoucher({ nonce: '1', credits: 2 })
  const alreadyClaimed = await signedVoucher({ nonce: '2' })
  const expired = await signedVoucher({ nonce: '3', deadline: 1 })
  const statuses: VoucherStatus[] = [
    { voucher: claimable, verifier: verifierWallet.address, digest: voucherDigest(claimable), state: 'claimable' },
    { voucher: alreadyClaimed, verifier: verifierWallet.address, digest: voucherDigest(alreadyClaimed), state: 'claimed' },
    { voucher: expired, verifier: verifierWallet.address, digest: voucherDigest(expired), state: 'expired' },
  ]

  const submitted: DelegateVoucherMessage[] = []
  const result = await claimDelegateVouchers({
    statuses,
    registry: {
      claimDelegateCredits: async (_signer, msg, signature) => {
        assert.equal(signature, claimable.signature)
        submitted.push(msg)
        return '0xtx'
      },
    },
    signer: verifierWallet,
  })

  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]!.nonce, 1n)
  assert.deepEqual(result, {
    claimedCount: 1,
    claimedCredits: 2,
    skippedClaimed: 1,
    skippedExpired: 1,
    failed: 0,
  })
})

test('one reverting voucher does not block claiming the next', async () => {
  const first = await signedVoucher({ nonce: '1' })
  const second = await signedVoucher({ nonce: '2', credits: 5 })
  const statuses: VoucherStatus[] = [first, second].map((voucher) => ({
    voucher,
    verifier: verifierWallet.address,
    digest: voucherDigest(voucher),
    state: 'claimable' as const,
  }))

  const failures: string[] = []
  let calls = 0
  const result = await claimDelegateVouchers({
    statuses,
    registry: {
      claimDelegateCredits: async () => {
        if (calls++ === 0) throw new Error('CommitmentBudgetExceeded')
        return '0xtx'
      },
    },
    signer: verifierWallet,
    onError: (_status, err) => failures.push(err.message),
  })

  assert.equal(result.failed, 1)
  assert.equal(result.claimedCount, 1)
  assert.equal(result.claimedCredits, 5)
  assert.deepEqual(failures, ['CommitmentBudgetExceeded'])
})
