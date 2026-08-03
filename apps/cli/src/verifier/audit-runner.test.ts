import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReferenceQueryProfile, type KbfReferenceV1 } from '@antseed/fingerprints'
import {
  VerificationStorage,
  type ConnectedRelay,
  type PeerId,
  type PeerInfo,
  type StoredAuditJob,
  type StoredAuditPlan,
} from '@antseed/node'
import type { AuditState } from '@antseed/node/payments'
import {
  deterministicScheduledAt,
  dispatchDueReferenceAuditJobs,
  planAndCommitReferenceAudit,
  resumeReferenceAuditCommit,
  selectRelayForJob,
  type AuditContext,
} from './audit-runner.js'

const NOW = 1_800_000_100_000
const AUDIT_ID = `0x${'11'.repeat(32)}`
const SERVICE = 'gpt-test'
const SELLER_PEER_ID = '22'.repeat(20)
const RELAY_A = '33'.repeat(20)
const RELAY_B = '44'.repeat(20)

function plan(): StoredAuditPlan {
  return {
    auditId: AUDIT_ID,
    state: 'committed',
    source: 'manual',
    epoch: '7',
    durationMs: 86_400_000,
    chainId: '31337',
    registryAddress: `0x${'55'.repeat(20)}`,
    treasuryAddress: `0x${'66'.repeat(20)}`,
    verifierAddress: `0x${'77'.repeat(20)}`,
    agentId: '9',
    targetPeerId: SELLER_PEER_ID,
    targetService: SERVICE,
    targetServiceHash: `0x${'88'.repeat(32)}`,
    targetSalt: `0x${'99'.repeat(32)}`,
    targetCommitment: `0x${'aa'.repeat(32)}`,
    probeRoot: `0x${'bb'.repeat(32)}`,
    auditJobRoot: `0x${'cc'.repeat(32)}`,
    referenceId: `0x${'dd'.repeat(32)}`,
    queryProfileHash: `0x${'ee'.repeat(32)}`,
    verifierConfigHash: `0x${'ff'.repeat(32)}`,
    probeCount: 10,
    jobCount: 1,
    requiredRelayCount: 1,
    jobTimeoutMs: 30_000,
    payoutPerJobUsdc: 1_000n,
    reservedBudgetUsdc: 1_000n,
    commitTxHash: `0x${'12'.repeat(32)}`,
    attestationTxHash: null,
    evidenceHash: null,
    evidenceUri: null,
    evidenceState: 'none',
    executeAfter: Math.floor(NOW / 1_000) - 10,
    executeBefore: Math.floor(NOW / 1_000) + 600,
    forceClaimAvailableAt: Math.floor(NOW / 1_000) + 22_200,
    forceClaimDeadline: Math.floor(NOW / 1_000) + 2_614_200,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    failureReason: null,
  }
}

function job(): StoredAuditJob {
  return {
    auditId: AUDIT_ID,
    jobIndex: 0,
    state: 'planned',
    scheduledAt: NOW - 1,
    relayPeerId: null,
    relayBuyerAddress: null,
    assignmentAttempt: 0,
    assignmentSignature: null,
    assignmentState: 'unassigned',
    assignedAt: null,
    lastDispatchAt: null,
    sellerPeerId: SELLER_PEER_ID,
    service: SERVICE,
    serviceHash: `0x${'88'.repeat(32)}`,
    requestHash: `0x${'13'.repeat(32)}`,
    jobSalt: `0x${'14'.repeat(32)}`,
    executeAfter: Math.floor(NOW / 1_000) - 10,
    executeBefore: Math.floor(NOW / 1_000) + 300,
    requestBytes: new Uint8Array([1, 2, 3]),
    positionalProof: [`0x${'15'.repeat(32)}`],
    responseBytes: null,
    responseAuthPayload: null,
    sellerChargeUsdc: null,
    paymentMetadata: null,
    dispatchedAt: null,
    completedAt: null,
    failureKind: null,
    failureMessage: null,
    entitlementPersistedAt: null,
  }
}

function relay(peerId: string, overrides: Partial<ConnectedRelay> = {}): ConnectedRelay {
  return {
    peerId: peerId as PeerId,
    chainId: '31337',
    registryAddress: `0x${'55'.repeat(20)}`,
    treasuryAddress: `0x${'66'.repeat(20)}`,
    minPayoutPerJobUsdc: 0n,
    maxConcurrentJobs: 2,
    activeJobs: 0,
    connectedAt: NOW,
    ...overrides,
  }
}

function auditState(): AuditState {
  const stored = plan()
  return {
    committer: stored.verifierAddress!,
    targetCommitment: stored.targetCommitment!,
    probeRoot: stored.probeRoot!,
    auditJobRoot: stored.auditJobRoot!,
    referenceId: stored.referenceId!,
    verifierConfigHash: stored.verifierConfigHash!,
    commitSequence: 1n,
    probeCount: stored.probeCount!,
    jobCount: stored.jobCount!,
    payoutPerJobUsdc: stored.payoutPerJobUsdc!,
    reservedRelayBudgetUsdc: stored.reservedBudgetUsdc!,
    totalRelayPaidUsdc: 0n,
    committedAt: stored.executeAfter! - 1,
    executeAfter: stored.executeAfter!,
    executeBefore: stored.executeBefore!,
    forceClaimAvailableAt: stored.forceClaimAvailableAt!,
    forceClaimDeadline: stored.forceClaimDeadline!,
    attestedAt: 0,
    attested: false,
    evidenceHash: `0x${'00'.repeat(32)}`,
    evidenceUri: '',
  }
}

function context(
  storage: VerificationStorage,
  runRelayJob: AuditContext['runRelayJob'],
): AuditContext {
  return {
    registryClient: {
      getAudit: async () => auditState(),
      signRelayAssignment: async (_signer: unknown, assignment: { attempt: number }) =>
        `0x${assignment.attempt.toString(16).padStart(2, '0')}${'ab'.repeat(64)}`,
    } as unknown as AuditContext['registryClient'],
    treasuryClient: {} as AuditContext['treasuryClient'],
    storage,
    signer: { getAddress: async () => plan().verifierAddress! } as AuditContext['signer'],
    chainId: '31337',
    registryAddress: plan().registryAddress!,
    treasuryAddress: plan().treasuryAddress!,
    runRelayJob,
    now: () => NOW,
  }
}

function successfulResult() {
  return {
    status: 'ok' as const,
    responseBytesBase64: Buffer.from([4, 5]).toString('base64'),
    responseAuthPayloadBase64: Buffer.from([6, 7]).toString('base64'),
    sellerChargeUsdc: '400',
    paymentMetadata: {
      spendingAuth: {
        channelId: `0x${'16'.repeat(32)}`,
        cumulativeAmount: '400',
      },
    },
  }
}

function withStorage(run: (storage: VerificationStorage, dbPath: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'audit-runner-'))
  const dbPath = join(directory, 'verification.db')
  const storage = new VerificationStorage(dbPath)
  return Promise.resolve(run(storage, dbPath)).finally(() => {
    try { storage.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  })
}

test('deterministic scheduling is stable and bounded across the audit duration', () => {
  const values = Array.from({ length: 50 }, (_unused, index) =>
    deterministicScheduledAt(AUDIT_ID, index, NOW, 86_400_000, 30_000))
  assert.deepEqual(values, Array.from({ length: 50 }, (_unused, index) =>
    deterministicScheduledAt(AUDIT_ID, index, NOW, 86_400_000, 30_000)))
  assert.ok(values.every((value) => value >= NOW && value <= NOW + 86_400_000 - 30_000))
  assert.ok(new Set(values).size > 45)
})

test('relay selection enforces payout, capacity, diversity, and least-used balancing', () => {
  const jobs = [{ ...job(), relayPeerId: RELAY_A }]
  const relays = [
    relay(RELAY_A),
    relay(RELAY_B),
    relay('55'.repeat(20), { minPayoutPerJobUsdc: 1_001n }),
    relay('66'.repeat(20), { activeJobs: 2 }),
  ]
  assert.equal(selectRelayForJob(jobs, relays, 1_000n, 2)?.peerId, RELAY_B)
  assert.equal(selectRelayForJob(jobs, [relay(RELAY_A)], 1_000n, 2), null)
})

test('late relay assignment is persisted before dispatch and successful evidence is durable', async () => {
  await withStorage(async (storage) => {
    storage.saveAuditPlan(plan(), [job()])
    let sawPersistedAssignment = false
    await dispatchDueReferenceAuditJobs(context(storage, async () => {
      const persisted = storage.listAuditJobs(AUDIT_ID)[0]!
      sawPersistedAssignment = persisted.state === 'assigned'
        && persisted.assignmentSignature !== null
        && persisted.lastDispatchAt === NOW
      return successfulResult()
    }), plan(), [relay(RELAY_A)])

    assert.equal(sawPersistedAssignment, true)
    assert.deepEqual(storage.listAuditJobs(AUDIT_ID)[0], {
      ...storage.listAuditJobs(AUDIT_ID)[0],
      state: 'succeeded',
      relayPeerId: RELAY_A,
      assignmentState: 'accepted',
      sellerChargeUsdc: 400n,
    })
  })
})

test('one dispatch pass balances multiple due jobs across independent relays', async () => {
  await withStorage(async (storage) => {
    const multiPlan = {
      ...plan(),
      probeCount: 20,
      jobCount: 2,
      requiredRelayCount: 2,
      reservedBudgetUsdc: 2_000n,
    }
    const jobs = [
      job(),
      {
        ...job(),
        jobIndex: 1,
        requestHash: `0x${'19'.repeat(32)}`,
        jobSalt: `0x${'1a'.repeat(32)}`,
      },
    ]
    storage.saveAuditPlan(multiPlan, jobs)
    const multiAudit = { ...auditState(), probeCount: 20, jobCount: 2, reservedRelayBudgetUsdc: 2_000n }
    const multiContext = context(storage, async () => ({ status: 'error', error: 'seller_timeout' }))
    multiContext.registryClient = {
      getAudit: async () => multiAudit,
      signRelayAssignment: async (_signer: unknown, assignment: { attempt: number }) =>
        `0x${assignment.attempt.toString(16).padStart(2, '0')}${'ab'.repeat(64)}`,
    } as unknown as AuditContext['registryClient']

    await dispatchDueReferenceAuditJobs(multiContext, multiPlan, [relay(RELAY_A), relay(RELAY_B)])
    assert.deepEqual(storage.listAuditJobs(AUDIT_ID).map((stored) => stored.relayPeerId), [RELAY_A, RELAY_B])
  })
})

test('explicit pre-execution rejection permits a new relay assignment with the next attempt', async () => {
  await withStorage(async (storage) => {
    storage.saveAuditPlan(plan(), [job()])
    await dispatchDueReferenceAuditJobs(context(storage, async () => ({ status: 'error', error: 'busy' })), plan(), [relay(RELAY_A)])
    assert.match(JSON.stringify(storage.listAuditJobs(AUDIT_ID)[0]), /"state":"due"/)
    assert.equal(storage.listAuditJobs(AUDIT_ID)[0]?.assignmentAttempt, 1)

    await dispatchDueReferenceAuditJobs(context(storage, async () => successfulResult()), plan(), [relay(RELAY_B)])
    const completed = storage.listAuditJobs(AUDIT_ID)[0]!
    assert.equal(completed.state, 'succeeded')
    assert.equal(completed.relayPeerId, RELAY_B)
    assert.equal(completed.assignmentAttempt, 1)
  })
})

test('uncertain delivery survives restart and never reassigns to a different relay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-restart-'))
  const dbPath = join(directory, 'verification.db')
  let storage = new VerificationStorage(dbPath)
  try {
    storage.saveAuditPlan(plan(), [job()])
    let firstSignature = ''
    await dispatchDueReferenceAuditJobs(context(storage, async (_peerId, offer) => {
      firstSignature = offer.verifierSignature
      throw new Error('network timeout')
    }), plan(), [relay(RELAY_A)])
    storage.close()
    storage = new VerificationStorage(dbPath)

    let alternateCalled = false
    await dispatchDueReferenceAuditJobs(context(storage, async () => {
      alternateCalled = true
      return successfulResult()
    }), plan(), [relay(RELAY_B)])
    assert.equal(alternateCalled, false)
    assert.equal(storage.listAuditJobs(AUDIT_ID)[0]?.relayPeerId, RELAY_A)

    let retriedSignature = ''
    await dispatchDueReferenceAuditJobs(context(storage, async (_peerId, offer) => {
      retriedSignature = offer.verifierSignature
      return successfulResult()
    }), plan(), [relay(RELAY_A)])
    assert.equal(retriedSignature, firstSignature)
    assert.equal(storage.listAuditJobs(AUDIT_ID)[0]?.state, 'succeeded')
  } finally {
    storage.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('restart recovery accepts an already-mined commit without recommitting', async () => {
  await withStorage(async (storage) => {
    const committingPlan = { ...plan(), state: 'committing' as const, commitTxHash: null }
    storage.saveAuditPlan(committingPlan, [job()])
    let commitCalls = 0
    const recoveryContext = context(storage, async () => ({ status: 'error' }))
    recoveryContext.registryClient = {
      getAudit: async () => auditState(),
      commitProbes: async () => {
        commitCalls += 1
        return `0x${'18'.repeat(32)}`
      },
    } as unknown as AuditContext['registryClient']

    const recovered = await resumeReferenceAuditCommit(recoveryContext, committingPlan)
    assert.equal(recovered.state, 'committed')
    assert.equal(commitCalls, 0)
    assert.equal(storage.getAuditPlan(AUDIT_ID)?.state, 'committed')
  })
})

test('planning defers when the epoch cannot fit the complete duration and safety margin', async () => {
  const profile = createReferenceQueryProfile({ upstreamModel: 'trusted-model' })
  const reference = {
    referenceId: `0x${'17'.repeat(32)}`,
    queryProfile: profile,
    probes: Array.from({ length: 10 }, (_unused, index) => ({ id: `p-${index}` })),
  } as unknown as KbfReferenceV1
  const target: PeerInfo = {
    peerId: SELLER_PEER_ID as PeerId,
    lastSeen: NOW,
    providers: ['test'],
    onChainAgentId: 9,
    providerPricing: {
      test: {
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        services: { [SERVICE]: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
      },
    },
  }
  const insufficientContext = {
    registryClient: {
      currentEpochWindow: async () => ({ epoch: 7n, startsAt: Math.floor(NOW / 1_000) - 100, endsAt: Math.floor(NOW / 1_000) + 3_600 }),
    },
    treasuryClient: {},
    storage: {},
    signer: { getAddress: async () => plan().verifierAddress! },
    chainId: '31337',
    registryAddress: plan().registryAddress!,
    treasuryAddress: plan().treasuryAddress!,
    runRelayJob: async () => ({ status: 'error' as const }),
    now: () => NOW,
  } as unknown as AuditContext

  await assert.rejects(planAndCommitReferenceAudit(insufficientContext, {
    target,
    service: SERVICE,
    reference,
    executionProfile: profile,
    flatRelayFeeUsdc: 100n,
    jobTimeoutMs: 30_000,
    durationMs: 86_400_000,
  }), /insufficient epoch time/)
})
