import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReferenceQueryProfile, type KbfProbe } from '@antseed/fingerprints'
import {
  VerificationStorage,
  type StoredCertifiedKbfProbe,
  type StoredDirectAudit,
  type StoredDirectAuditProbe,
} from '@antseed/node'
import {
  certificationProfileHash,
  eligibleCatalogProbes,
  maximumAvailabilityDeficit,
  nextAdaptiveProbeCount,
  selectCatalogProbes,
} from './probe-catalog.js'
import type { ResolvedReferenceSource } from './reference-config.js'

const SERVICE = 'gpt-5.6-sol'
const source: ResolvedReferenceSource = {
  upstream: { baseUrl: 'https://reference.test/v1', sourceId: 'venice-smoke', trust: 'smoke' },
  model: SERVICE,
  contrastModels: ['kimi-k3', 'gpt-5.6-luna', 'sonnet-4.8'],
  policy: {
    minimumAuditProbeCount: 100,
    maximumAuditProbeCount: 500,
    auditProbeStep: 10,
    minimumStatisticalPower: 0.9,
    minimumMismatchDelta: 0.1,
    familyWideAlpha: 0.05,
    referenceConfidence: 0.99,
    minimumAuthenticatedCoverage: 1,
    maxReferenceAgeDays: 49,
    maxRequestsPerRound: 2000,
    requestTimeoutMs: 120_000,
    batchRetryCount: 3,
    generationDomainConcurrency: 3,
    maxConcurrentReferenceRequests: 4,
    maxConcurrentRequestsPerModel: 2,
  },
}

function directAudit(auditId: string, agentId: string): StoredDirectAudit {
  const now = Date.now()
  return {
    auditId,
    state: 'pending',
    source: 'automatic',
    epoch: '1',
    verifierAddress: null,
    agentId,
    sellerAddress: null,
    targetPeerId: agentId.padStart(40, '0'),
    targetService: SERVICE,
    targetServiceHash: null,
    referenceId: `reference-${auditId}`,
    queryProfileHash: null,
    probeCount: 10,
    authenticatedProbeCount: 0,
    statisticalPower: null,
    verdict: null,
    modelShareBps: null,
    metrics: null,
    evidencePath: null,
    evidenceHash: null,
    evidenceUri: null,
    attestationTxHash: null,
    credited: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    failureReason: null,
  }
}

function selectedProbe(auditId: string, ordinal: number): StoredDirectAuditProbe {
  return {
    auditId,
    ordinal,
    probeId: `probe-${String(ordinal).padStart(3, '0')}`,
    status: 'selected',
    requestId: null,
    requestHash: null,
    responseHash: null,
    responseAuth: null,
    payment: null,
    timing: null,
    matched: null,
    exposureCountedAt: null,
    failureReason: null,
  }
}

function catalogProbe(index: number, now: number): StoredCertifiedKbfProbe {
  const probe: KbfProbe = {
    id: `probe-${String(index).padStart(3, '0')}`,
    name: `fact ${index}`,
    domain: 'test',
    template: `Fact ${index} is ___.`,
    consensus: index,
    range: [0, 1_000],
    tolerance: { mode: 'absolute', value: 0 },
  }
  return {
    service: SERVICE,
    certificationHash: certificationProfileHash(source),
    probeId: probe.id,
    probe: probe as unknown as Record<string, unknown>,
    certification: { stable: true },
    queryProfile: createReferenceQueryProfile({ upstreamModel: SERVICE }) as unknown as Record<string, unknown>,
    sourceId: 'venice-smoke',
    trust: 'smoke',
    certifiedAt: now,
    expiresAt: now + 60_000,
    healthy: true,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  }
}

test('round generation uses the maximum target deficit rather than the sum', () => {
  assert.equal(maximumAvailabilityDeficit(100, [90, 35, 140]), 65)
  assert.equal(maximumAvailabilityDeficit(100, [100, 120]), 0)
})

test('adaptive growth advances exactly one configured step and caps at the maximum', () => {
  assert.equal(nextAdaptiveProbeCount(100, 10, 500), 110)
  assert.equal(nextAdaptiveProbeCount(490, 10, 500), 500)
  assert.equal(nextAdaptiveProbeCount(500, 10, 500), 500)
})

test('exposure is permanent for one agent while another agent can reuse the probe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-probe-catalog-'))
  const storage = new VerificationStorage(join(dir, 'verification.db'))
  try {
    const now = Date.now()
    storage.upsertCertifiedKbfProbes(Array.from({ length: 110 }, (_, index) => catalogProbe(index, now)))
    storage.saveDirectAudit(directAudit('audit-a', '7'))
    storage.saveDirectAuditProbes(Array.from({ length: 10 }, (_, ordinal) => selectedProbe('audit-a', ordinal)))
    for (let ordinal = 0; ordinal < 10; ordinal += 1) {
      storage.markDirectAuditProbeExposure('audit-a', ordinal, now)
    }

    const sameAgent = eligibleCatalogProbes({ storage, agentId: '7', service: SERVICE, source, now })
    const otherAgent = eligibleCatalogProbes({ storage, agentId: '8', service: SERVICE, source, now })
    assert.equal(sameAgent.length, 100)
    assert.equal(otherAgent.length, 110)
    assert.equal(selectCatalogProbes('audit-b', sameAgent, 100).length, 100)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
