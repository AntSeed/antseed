import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import {
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  validateKbfReferenceV1,
  type AuditResultFragment,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { RelayTreasuryReservation, VerifierRegistryClient } from '@antseed/node/payments'
import { publishEvidenceOnce, type AttestationRuntime } from './attestation.js'
import {
  canonicalEvidenceBytes,
  canonicalEvidenceHash,
  createCanonicalAuditEvidenceV2,
  verifyCanonicalEvidenceFile,
  writeCanonicalEvidence,
} from './evidence-v2.js'
import type { CommittedAuditPlan } from './audit-state.js'

function reference(): KbfReferenceV1 {
  const probes = Array.from({ length: 100 }, (_unused, index) => ({
    id: `p-${index}`,
    name: `probe-${index}`,
    domain: 'test',
    template: `Probe ${index} is ___.`,
    consensus: index,
    range: [0, 1_000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0.1 },
    advisoryConsensus: false,
  }))
  const value: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: 'gpt-test',
    serviceAliases: ['gpt-test'],
    createdAt: '2026-07-31T12:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'gpt-test' }),
    selfTest: {
      hamming: 0,
      total: probes.length,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: 100,
    minimumMismatchDelta: 0.1,
    statisticalPower: computeBinomialPower({
      selfHamming: 0,
      selfTotal: probes.length,
      minimumMismatchDelta: 0.1,
    }).power,
    statisticalPowerEvidence: (() => {
      const power = computeBinomialPower({ selfHamming: 0, selfTotal: probes.length, minimumMismatchDelta: 0.1 })
      return {
        test: 'one-sided-binomial' as const,
        alpha: 0.05 as const,
        clopperPearsonConfidence: 0.99 as const,
        selfHamming: 0,
        selfTotal: probes.length,
        p0UpperBound: power.p0,
        alternativeMismatchRate: power.p1,
        criticalMismatchCount: power.criticalMismatchCount,
        power: power.power,
      }
    })(),
    contrasts: [],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

function plan(referenceId: string): CommittedAuditPlan {
  return {
    auditId: `0x${'11'.repeat(32)}`,
    state: 'attested',
    source: 'manual',
    epoch: '1',
    durationMs: 86_400_000,
    chainId: 'base-local',
    registryAddress: `0x${'22'.repeat(20)}`,
    treasuryAddress: `0x${'33'.repeat(20)}`,
    verifierAddress: `0x${'44'.repeat(20)}`,
    agentId: '1',
    targetPeerId: '55'.repeat(20),
    targetService: 'gpt-test',
    targetServiceHash: `0x${'66'.repeat(32)}`,
    targetSalt: `0x${'77'.repeat(32)}`,
    targetCommitment: `0x${'88'.repeat(32)}`,
    probeRoot: `0x${'99'.repeat(32)}`,
    auditJobRoot: `0x${'aa'.repeat(32)}`,
    referenceId,
    queryProfileHash: `0x${'bb'.repeat(32)}`,
    verifierConfigHash: `0x${'cc'.repeat(32)}`,
    probeCount: 100,
    jobCount: 10,
    requiredRelayCount: 3,
    jobTimeoutMs: 120_000,
    payoutPerJobUsdc: 1_000n,
    reservedBudgetUsdc: 10_000n,
    commitTxHash: `0x${'dd'.repeat(32)}`,
    attestationTxHash: `0x${'ee'.repeat(32)}`,
    evidenceHash: null,
    evidenceUri: null,
    evidenceState: 'local',
    executeAfter: 100,
    executeBefore: 200,
    forceClaimAvailableAt: 300,
    forceClaimDeadline: 400,
    createdAt: 1,
    updatedAt: 2,
    failureReason: null,
  }
}

function evidenceFixture() {
  const ref = reference()
  const auditPlan = plan(ref.referenceId)
  const kbf: AuditResultFragment = {
    verifier: { kind: 'kbf', package: '@antseed/fingerprints', version: '0.1.0' },
    referenceId: ref.referenceId,
    referenceModel: ref.referenceModel,
    probeCount: 100,
    parsedProbeCount: 0,
    matchVector: Array.from({ length: 100 }, () => null),
    matchVectorHash: `0x${'ff'.repeat(32)}`,
    stats: {
      selfHamming: 0,
      selfTotal: 100,
      targetHamming: null,
      targetTotal: null,
      selfCoverage: 1,
      targetCoverage: 0,
      p0Cp99: null,
      pValueBinomial: null,
    },
    verdict: 'UNDETERMINED',
    verdictReason: 'test',
  }
  const reservation: RelayTreasuryReservation = {
    epoch: 1n,
    jobCount: 10,
    paidJobCount: 0,
    payoutPerJobUsdc: 1_000n,
    totalBudgetUsdc: 10_000n,
    remainingBudgetUsdc: 10_000n,
    releaseAfter: 400,
    released: false,
  }
  const evidence = createCanonicalAuditEvidenceV2({
    plan: auditPlan,
    reference: ref,
    exactSubsetBaseline: ref.selfTest,
    jobs: [],
    kbf,
    reservation,
    relayPaidBitmap: 0n,
    modelShareBps: 0,
    usageAttributionAvailable: false,
    epochStartedAt: 0,
    epochEndedAt: 200,
    verifierConfiguration: { schema: 2 },
    createdAt: new Date('2026-07-31T12:30:00.000Z'),
  })
  return { auditPlan, evidence }
}

test('canonical evidence bytes, hash, and file verification are stable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-evidence-'))
  try {
    const path = join(dir, 'evidence.json')
    const { evidence } = evidenceFixture()
    assert.equal(validateKbfReferenceV1(evidence.reference).referenceId, evidence.audit.referenceId)
    const bytes = canonicalEvidenceBytes(evidence)
    const hash = canonicalEvidenceHash(evidence)
    await writeCanonicalEvidence(path, evidence)
    assert.deepEqual(readFileSync(path), Buffer.from(bytes))
    await verifyCanonicalEvidenceFile(path, hash)
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
    await assert.rejects(verifyCanonicalEvidenceFile(path, hash), /not canonical JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishEvidenceOnce verifies byte identity and publishes exactly once', async () => {
  const { auditPlan, evidence } = evidenceFixture()
  const evidenceHash = canonicalEvidenceHash(evidence)
  auditPlan.evidenceHash = evidenceHash
  let evidenceUri = ''
  let publishCalls = 0
  let updatedState: Record<string, unknown> | null = null
  const registry = {
    getAudit: async () => ({ evidenceUri }),
    publishEvidence: async (_signer: unknown, _auditId: string, uri: string) => {
      publishCalls += 1
      evidenceUri = uri
      return `0x${'12'.repeat(32)}`
    },
  } as unknown as VerifierRegistryClient
  const runtime = {
    registryClient: registry,
    treasuryClient: {},
    storage: {
      getAuditPlan: () => auditPlan,
      updateAuditState: (_auditId: string, _state: string, fields: Record<string, unknown>) => {
        updatedState = fields
      },
    },
    signer: Wallet.createRandom(),
    dataDir: '/tmp',
  } as unknown as AttestationRuntime
  let uploaded: Uint8Array<ArrayBufferLike> = new Uint8Array()
  const first = await publishEvidenceOnce({
    runtime,
    auditId: auditPlan.auditId,
    evidence,
    upload: async (bytes) => {
      uploaded = bytes
      return 'ipfs://evidence-test'
    },
    download: async () => uploaded,
  })
  assert.equal(first.uri, 'ipfs://evidence-test')
  assert.equal(publishCalls, 1)
  assert.deepEqual(updatedState, { evidenceUri: 'ipfs://evidence-test', evidenceState: 'published' })
  await assert.rejects(
    publishEvidenceOnce({
      runtime,
      auditId: auditPlan.auditId,
      evidence,
      upload: async () => { throw new Error('must not upload twice') },
      download: async () => new Uint8Array(),
    }),
    /already published/,
  )
  assert.equal(publishCalls, 1)
})

test('publishEvidenceOnce rejects changed downloaded bytes before the chain write', async () => {
  const { auditPlan, evidence } = evidenceFixture()
  auditPlan.evidenceHash = canonicalEvidenceHash(evidence)
  let publishCalls = 0
  const runtime = {
    registryClient: {
      getAudit: async () => ({ evidenceUri: '' }),
      publishEvidence: async () => {
        publishCalls += 1
        return `0x${'12'.repeat(32)}`
      },
    },
    treasuryClient: {},
    storage: { getAuditPlan: () => auditPlan, updateAuditState: () => {} },
    signer: Wallet.createRandom(),
    dataDir: '/tmp',
  } as unknown as AttestationRuntime
  await assert.rejects(
    publishEvidenceOnce({
      runtime,
      auditId: auditPlan.auditId,
      evidence,
      upload: async () => 'ipfs://changed',
      download: async () => new TextEncoder().encode('{}'),
    }),
    /not byte-identical/,
  )
  assert.equal(publishCalls, 0)
})
