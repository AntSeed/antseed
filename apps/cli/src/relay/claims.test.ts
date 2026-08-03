import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet, ZeroHash } from 'ethers'
import {
  VerificationStorage,
  type StoredRelayEntitlement,
} from '@antseed/node'
import type { VerifierRegistryClient } from '@antseed/node/payments'
import { forceClaimEntitlement, reconcileRelayEntitlements } from '../cli/commands/relay/claims.js'

const AUDIT_ID = `0x${'11'.repeat(32)}`
const RELAY = `0x${'22'.repeat(20)}`
const SELLER = `0x${'33'.repeat(20)}`
const SERVICE_HASH = `0x${'44'.repeat(32)}`

function entitlement(jobIndex: number, overrides: Partial<StoredRelayEntitlement> = {}): StoredRelayEntitlement {
  const requestHash = `0x${(50 + jobIndex).toString(16).padStart(2, '0').repeat(32)}`
  return {
    auditId: AUDIT_ID,
    jobIndex,
    relayPeerId: RELAY.slice(2),
    relayBuyerAddress: RELAY,
    registryAddress: `0x${'55'.repeat(20)}`,
    treasuryAddress: `0x${'66'.repeat(20)}`,
    job: {
      auditId: AUDIT_ID,
      jobIndex,
      sellerPeerId: SELLER,
      serviceHash: SERVICE_HASH,
      requestHash,
      jobSalt: `0x${'77'.repeat(32)}`,
      executeAfter: 10,
      executeBefore: 20,
    },
    positionalProof: [`0x${'88'.repeat(32)}`],
    assignment: {
      auditId: AUDIT_ID,
      jobIndex,
      attempt: 0,
      relayBuyer: RELAY,
      payoutPerJobUsdc: '1000',
      executeAfter: 10,
      executeBefore: 20,
    },
    verifierSignature: `0x${'99'.repeat(65)}`,
    responseBytes: new Uint8Array([1, 2, 3]),
    responseAuthPayload: new Uint8Array(66),
    payoutUsdc: 1_000n,
    sellerChargeUsdc: 400n,
    paymentMetadata: { requestHash },
    forceClaimAvailableAt: 30,
    forceClaimDeadline: 40,
    state: 'awaiting-attestation',
    claimTxHash: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

async function withStorage(run: (storage: VerificationStorage) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-relay-claims-'))
  const storage = new VerificationStorage(join(dir, 'verification.db'))
  try {
    await run(storage)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reconcileRelayEntitlements recovers paid, challengeable, and expired states after restart', async () => {
  await withStorage(async (storage) => {
    storage.persistRelayEntitlement(entitlement(0))
    storage.persistRelayEntitlement(entitlement(1))
    storage.persistRelayEntitlement(entitlement(2, { forceClaimDeadline: 35 }))
    const registry = {
      isRelayJobPaid: async (_auditId: string, jobIndex: number) => jobIndex === 0,
    } as unknown as VerifierRegistryClient
    await reconcileRelayEntitlements(storage, registry, 36)
    assert.equal(storage.getRelayEntitlement(AUDIT_ID, 0)?.state, 'paid')
    assert.equal(storage.getRelayEntitlement(AUDIT_ID, 1)?.state, 'challenge-available')
    assert.equal(storage.getRelayEntitlement(AUDIT_ID, 2)?.state, 'expired')
  })
})

test('forceClaimEntitlement validates proof and ResponseAuth before persisting the paid transaction', async () => {
  await withStorage(async (storage) => {
    const stored = entitlement(0, { state: 'challenge-available' })
    storage.persistRelayEntitlement(stored)
    let submittedClaim: unknown = null
    const registry = {
      isRelayJobPaid: async () => false,
      getAudit: async () => ({ auditJobRoot: `0x${'99'.repeat(32)}`, jobCount: 10 }),
      hashAuditJob: async () => `0x${'aa'.repeat(32)}`,
      verifyAuditJobProof: async () => true,
      parseResponseAuthPayload: async () => ({
        buyer: RELAY,
        seller: SELLER,
        advertisedServiceHash: SERVICE_HASH,
        statusCode: 200,
        requestHash: stored.job.requestHash,
        responseHash: `0x${'bb'.repeat(32)}`,
        responseStartedAt: 10_000,
        responseCompletedAt: 20_000,
      }),
      paidRequestHash: async () => ZeroHash,
      forceClaimRelayJob: async (_signer: unknown, _auditId: string, claim: unknown) => {
        submittedClaim = claim
        return `0x${'cc'.repeat(32)}`
      },
    } as unknown as VerifierRegistryClient
    const txHash = await forceClaimEntitlement(storage, registry, new Wallet(`0x${'99'.repeat(32)}`), stored, 35)
    assert.equal(txHash, `0x${'cc'.repeat(32)}`)
    assert.ok(submittedClaim)
    assert.equal(storage.getRelayEntitlement(AUDIT_ID, 0)?.state, 'paid')
    assert.equal(storage.getRelayEntitlement(AUDIT_ID, 0)?.claimTxHash, txHash)
  })
})

test('forceClaimEntitlement rejects replayed request hashes before submission', async () => {
  await withStorage(async (storage) => {
    const stored = entitlement(0, { state: 'challenge-available' })
    storage.persistRelayEntitlement(stored)
    let submitted = false
    const registry = {
      isRelayJobPaid: async () => false,
      getAudit: async () => ({ auditJobRoot: `0x${'99'.repeat(32)}`, jobCount: 10 }),
      hashAuditJob: async () => `0x${'aa'.repeat(32)}`,
      verifyAuditJobProof: async () => true,
      parseResponseAuthPayload: async () => ({
        buyer: RELAY,
        seller: SELLER,
        advertisedServiceHash: SERVICE_HASH,
        statusCode: 200,
        requestHash: stored.job.requestHash,
        responseHash: `0x${'bb'.repeat(32)}`,
        responseStartedAt: 10_000,
        responseCompletedAt: 20_000,
      }),
      paidRequestHash: async () => `0x${'dd'.repeat(32)}`,
      forceClaimRelayJob: async () => {
        submitted = true
        return `0x${'cc'.repeat(32)}`
      },
    } as unknown as VerifierRegistryClient
    await assert.rejects(
      forceClaimEntitlement(storage, registry, new Wallet(`0x${'99'.repeat(32)}`), stored, 35),
      /request hash is already paid/,
    )
    assert.equal(submitted, false)
  })
})
