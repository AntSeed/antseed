import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeBinomialPower,
  createReferenceQueryProfile,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { StoredCertifiedKbfProbe, VerificationStorage } from '@antseed/node'
import type { VerifierCLIConfig } from '../config/types.js'
import { prepareBenchmarkReference } from './benchmark-reference.js'

const SERVICE = 'gpt-5.6-sol'
const NOW = 1_800_000_000_000

function storedProbe(index: number): StoredCertifiedKbfProbe {
  const probe: KbfProbe = {
    id: `probe-${String(index).padStart(3, '0')}`,
    name: `probe-${index}`,
    domain: 'test',
    template: `Probe ${index} is ___.`,
    consensus: index,
    range: [0, 1000],
    tolerance: { mode: 'absolute', value: 0 },
  }
  return {
    service: SERVICE,
    certificationHash: 'unused-by-fake-storage',
    probeId: probe.id,
    probe: probe as unknown as Record<string, unknown>,
    certification: {},
    queryProfile: createReferenceQueryProfile({ upstreamModel: SERVICE }) as unknown as Record<string, unknown>,
    sourceId: 'antseed-venice-sol-smoke-v1',
    trust: 'smoke',
    certifiedAt: NOW,
    expiresAt: NOW + 86_400_000,
    healthy: true,
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function verifierConfig(): VerifierCLIConfig {
  return {
    referenceEndpoint: {
      baseUrl: 'http://127.0.0.1:8377/v1',
      sourceId: 'antseed-venice-sol-smoke-v1',
      trust: 'smoke',
      antseedPeerId: '9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7',
      models: {
        [SERVICE]: {
          upstreamModel: SERVICE,
          contrastModels: ['kimi-k3', 'gpt-5.6-luna', 'sonnet-4.6'],
        },
      },
    },
    referencePolicy: {
      minimumAuditProbeCount: 100,
      maximumAuditProbeCount: 100,
      minimumStatisticalPower: 0.9,
      maxConcurrentReferenceRequests: 20,
      maxConcurrentRequestsPerModel: 5,
    },
  }
}

test('benchmark reference keeps partial stable smoke batches until the catalog reaches 100', async () => {
  let catalog = Array.from({ length: 50 }, (_unused, index) => storedProbe(index))
  const requested: number[] = []
  let selfTestCount = 0
  const storage = {
    listCertifiedKbfProbes: () => catalog,
  } as unknown as VerificationStorage
  const queryProfile = createReferenceQueryProfile({ upstreamModel: SERVICE })
  const reference: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: 'sha256:reference',
    referenceModel: SERVICE,
    serviceAliases: [SERVICE],
    createdAt: new Date(NOW).toISOString(),
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: { trust: 'smoke' } },
    queryProfile,
    selfTest: { hamming: 0, total: 100, coverage: 1, errorRate: 0, outcomes: [] },
    probes: Array.from({ length: 100 }, (_unused, index) => storedProbe(index).probe as unknown as KbfProbe),
    selectedProbeCount: 100,
    minimumMismatchDelta: 0.1,
    statisticalPower: 0.95,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: 100,
      p0UpperBound: 0.05,
      alternativeMismatchRate: 0.15,
      criticalMismatchCount: 10,
      power: 0.95,
    },
    contrasts: [],
  }

  const prepared = await prepareBenchmarkReference({
    storage,
    runId: 'benchmark-run',
    service: SERVICE,
    verifierConfig: verifierConfig(),
    referencesDir: '/tmp/references',
    sizing: {
      mode: 'fixed',
      minimumProbeCount: 100,
      maximumProbeCount: 100,
      probeStep: 100,
      minimumStatisticalPower: 0.9,
      minimumMismatchDelta: 0.1,
      alpha: 0.05,
      cpConfidence: 0.99,
    },
    now: NOW,
  }, {
    certify: async (input) => {
      requested.push(input.requiredCount)
      assert.equal(input.minimumCertifiedCount, 10)
      assert.equal(input.generationProbeCount, 50)
      assert.equal(input.persistAllGenerated, true)
      assert.equal(input.source.policy.maxConcurrentReferenceRequests, 4)
      assert.equal(input.source.policy.maxConcurrentRequestsPerModel, 2)
      const additionCount = requested.length === 1 ? 43 : 7
      const start = catalog.length
      catalog = [
        ...catalog,
        ...Array.from({ length: additionCount }, (_unused, index) => storedProbe(start + index)),
      ]
      return {
        probes: catalog.slice(start),
        generated: additionCount,
        inserted: additionCount,
        known: 0,
        rejected: input.requiredCount - additionCount,
        unhealthy: 0,
        requestCount: 0,
        retryCount: 0,
        failureCount: 0,
      }
    },
    selfTest: async (input) => {
      selfTestCount = input.probes.length
      return {
        outcomes: input.probes.map((probe) => ({ probeId: probe.probeId, answer: 1, match: 1 as const })),
        requestCount: 10,
        retryCount: 0,
        failureCount: 0,
      }
    },
    materialize: async (input) => {
      assert.equal(input.probes.length, 100)
      assert.equal(input.selfTestOutcomes.length, 100)
      return { reference, outPath: '/tmp/references/shared.json' }
    },
  })

  assert.deepEqual(requested, [50, 7])
  assert.equal(selfTestCount, 100)
  assert.equal(prepared.reference, reference)
  assert.equal(prepared.trust, 'smoke')
})

test('benchmark reference grows from 100 to the first cohort-powered probe count', async () => {
  const catalog = Array.from({ length: 110 }, (_unused, index) => storedProbe(index))
  const storage = {
    listCertifiedKbfProbes: () => catalog,
  } as unknown as VerificationStorage
  const testedCounts: number[] = []

  const prepared = await prepareBenchmarkReference({
    storage,
    runId: 'adaptive-benchmark-run',
    service: SERVICE,
    verifierConfig: verifierConfig(),
    referencesDir: '/tmp/references',
    sizing: {
      mode: 'auto',
      minimumProbeCount: 100,
      maximumProbeCount: 110,
      probeStep: 10,
      minimumStatisticalPower: 0.9,
      minimumMismatchDelta: 0.1,
      alpha: 0.00625,
      cpConfidence: 0.99,
    },
    now: NOW,
  }, {
    selfTest: async (input) => {
      testedCounts.push(input.probes.length)
      return {
        outcomes: input.probes.map((probe) => ({ probeId: probe.probeId, answer: 1, match: 1 as const })),
        requestCount: 1,
        retryCount: 0,
        failureCount: 0,
      }
    },
    materialize: async (input) => {
      const power = computeBinomialPower({
        selfHamming: 0,
        selfTotal: input.probes.length,
        minimumMismatchDelta: input.minimumMismatchDelta!,
        alpha: input.alpha,
        cpConfidence: input.cpConfidence,
      })
      const queryProfile = createReferenceQueryProfile({ upstreamModel: SERVICE })
      return {
        outPath: '/tmp/references/adaptive.json',
        reference: {
          version: 1,
          kind: 'kbf',
          referenceId: 'sha256:adaptive',
          referenceModel: SERVICE,
          serviceAliases: [SERVICE],
          createdAt: new Date(NOW).toISOString(),
          source: 'generated',
          generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
          queryProfile,
          selfTest: {
            hamming: 0,
            total: input.probes.length,
            coverage: 1,
            errorRate: 0,
            outcomes: [...input.selfTestOutcomes],
          },
          probes: input.probes.map((probe) => probe.probe as unknown as KbfProbe),
          selectedProbeCount: input.probes.length,
          minimumMismatchDelta: input.minimumMismatchDelta!,
          statisticalPower: power.power,
          statisticalPowerEvidence: {
            test: 'one-sided-binomial',
            alpha: input.alpha!,
            clopperPearsonConfidence: input.cpConfidence!,
            selfHamming: 0,
            selfTotal: input.probes.length,
            p0UpperBound: power.p0,
            alternativeMismatchRate: power.p1,
            criticalMismatchCount: power.criticalMismatchCount,
            power: power.power,
          },
          contrasts: [],
        },
      }
    },
  })

  assert.deepEqual(testedCounts, [100, 10])
  assert.equal(prepared.reference.selectedProbeCount, 110)
  assert.ok(prepared.reference.statisticalPower >= 0.9)
})
