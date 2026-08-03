import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  validateKbfReferenceV1,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { VerificationStorage, type StoredAuditPlan } from '@antseed/node'
import { selectAndReserveReferenceSubset } from './reference-subset.js'

const SERVICE = 'gpt-5.6-sol'

function reference(): KbfReferenceV1 {
  const probes = Array.from({ length: 200 }, (_unused, index) => ({
    id: `probe-${String(index).padStart(3, '0')}`,
    name: `probe-${index}`,
    domain: 'test',
    template: `Probe ${index} is ___.`,
    consensus: index,
    range: [0, 1_000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
    advisoryConsensus: false,
  }))
  const power = computeBinomialPower({ selfHamming: 0, selfTotal: probes.length, minimumMismatchDelta: 0.1 })
  const value: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: SERVICE,
    serviceAliases: [SERVICE],
    createdAt: '2026-08-03T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: createReferenceQueryProfile({ upstreamModel: SERVICE }),
    selfTest: {
      hamming: 0,
      total: probes.length,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: probes.length,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

function plan(auditId: string, agentId: string, referenceId: string): StoredAuditPlan {
  return {
    auditId,
    state: 'planned',
    source: 'automatic',
    epoch: '1',
    durationMs: 86_400_000,
    chainId: null,
    registryAddress: null,
    treasuryAddress: null,
    verifierAddress: null,
    agentId,
    targetPeerId: agentId.padStart(40, '0'),
    targetService: SERVICE,
    targetServiceHash: null,
    targetSalt: null,
    targetCommitment: null,
    probeRoot: null,
    auditJobRoot: null,
    referenceId,
    queryProfileHash: null,
    verifierConfigHash: null,
    probeCount: 100,
    jobCount: 10,
    requiredRelayCount: null,
    jobTimeoutMs: 120_000,
    payoutPerJobUsdc: null,
    reservedBudgetUsdc: null,
    commitTxHash: null,
    attestationTxHash: null,
    evidenceHash: null,
    evidenceUri: null,
    evidenceState: 'none',
    executeAfter: null,
    executeBefore: null,
    forceClaimAvailableAt: null,
    forceClaimDeadline: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    failureReason: null,
  }
}

test('selection isolates targets and permanently prevents same-agent probe reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-reference-rotation-'))
  const storage = new VerificationStorage(join(dir, 'verification.db'))
  try {
    const full = validateKbfReferenceV1(reference())
    const select = (auditId: string, agentId: string) => {
      storage.saveAuditPlan(plan(auditId, agentId, full.referenceId))
      return selectAndReserveReferenceSubset({
        storage,
        auditId,
        agentId,
        service: SERVICE,
        reference: full,
        probeCount: 100,
      })
    }

    const first = select('audit-1', '7')
    const concurrent = select('audit-2', '7')
    assert.equal(first.referenceId, full.referenceId)
    assert.equal(first.parentReferenceId, full.referenceId)
    assert.equal(new Set(first.probes.map((probe) => probe.id)).size, 100)
    assert.equal(first.probes.some((probe) => concurrent.probes.some((other) => other.id === probe.id)), false)

    for (let jobIndex = 0; jobIndex < 10; jobIndex += 1) {
      storage.markAuditJobProbeExposure('audit-1', jobIndex)
    }
    assert.throws(() => select('audit-3', '7'), /rebuild required/)

    const otherTarget = select('audit-5', '8')
    assert.equal(otherTarget.probes.length, 100)
    assert.equal(validateKbfReferenceV1(full).referenceId, full.referenceId)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
