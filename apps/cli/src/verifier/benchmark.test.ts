import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  VerificationStorage,
  type PeerInfo,
  type StoredBenchmarkRun,
  type StoredBenchmarkTarget,
} from '@antseed/node'
import { createDefaultConfig } from '../config/defaults.js'
import { renderBenchmarkReport } from '../cli/commands/verifier/benchmark.js'
import type { DirectAuditObservationResult } from './audit-runner.js'
import {
  attestBenchmarkAudits,
  buildBenchmarkReport,
  classifyBenchmarkEligibility,
  runBenchmarkObservation,
} from './benchmark.js'
import type { PreparedBenchmarkReference } from './benchmark-reference.js'
import type { VerifierRuntime } from './runtime.js'

const NOW = 1_800_000_000_000
const SERVICE = 'gpt-5.6-sol'
const VERIFIER_PEER_ID = '11'.repeat(20)
const VERIFIER_ADDRESS = `0x${VERIFIER_PEER_ID}`

function peer(input: {
  id: string
  agentId?: number
  responseAuth?: boolean
  service?: string
}): PeerInfo {
  const service = input.service ?? SERVICE
  return {
    peerId: input.id.repeat(40).slice(0, 40) as PeerInfo['peerId'],
    lastSeen: NOW,
    providers: ['mock'],
    capabilities: input.responseAuth === false ? [] : [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    ...(input.agentId === undefined ? {} : {
      onChainAgentId: input.agentId,
      onChainSellerAddress: `0x${input.id.repeat(40).slice(0, 40)}`,
    }),
    metadata: {
      version: 1,
      peerId: input.id.repeat(40).slice(0, 40),
      displayName: `peer-${input.id}`,
      timestamp: NOW,
      providers: [{ name: 'mock', services: [service] }],
    } as unknown as PeerInfo['metadata'],
  }
}

function reference(): KbfReferenceV1 {
  return {
    version: 1,
    kind: 'kbf',
    referenceId: 'sha256:shared-reference',
    referenceModel: SERVICE,
    serviceAliases: [SERVICE],
    createdAt: new Date(NOW).toISOString(),
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: { trust: 'smoke' } },
    queryProfile: {} as KbfReferenceV1['queryProfile'],
    selfTest: { hamming: 0, total: 100, coverage: 1, errorRate: 0, outcomes: [] },
    probes: [],
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
    contrasts: [{ model: 'kimi-k3', distinguishingProbeIds: [] }],
  }
}

function benchmarkRun(runId: string): StoredBenchmarkRun {
  return {
    runId,
    state: 'completed',
    mode: 'observe',
    service: SERVICE,
    epoch: '7',
    referenceId: null,
    certificationHash: null,
    queryProfileHash: null,
    probeSizingMode: 'fixed',
    probeCount: 100,
    minimumProbeCount: 100,
    maximumProbeCount: 100,
    probeStep: 100,
    familyWideAlpha: 0.05,
    perPeerAlpha: 0.05,
    minimumMismatchDelta: 0.1,
    referenceConfidence: 0.99,
    minimumStatisticalPower: 0.9,
    achievedStatisticalPower: 0.95,
    referenceErrorUpperBound: 0.05,
    criticalMismatchCount: 10,
    minimumTargetCoverage: 1,
    maxTotalUsdc: '1000',
    spentUsdc: '0',
    discoveredCount: 0,
    eligibleCount: 0,
    completedCount: 0,
    failedCount: 0,
    referencePath: null,
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  }
}

function benchmarkTarget(runId: string, ordinal: number): StoredBenchmarkTarget {
  return {
    runId,
    ordinal,
    peerId: ordinal.toString(16).padStart(40, '0'),
    agentId: null,
    displayName: `peer-${ordinal}`,
    publicAddress: null,
    advertisedService: SERVICE,
    eligibility: 'ineligible',
    state: 'skipped',
    eligibilityReason: 'missing on-chain agent id',
    auditId: null,
    sellerChargeUsdc: '0',
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

test('benchmark observes all eligible peers with one shared reference and no attestation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-benchmark-'))
  const storage = new VerificationStorage(join(dir, 'verification.db'))
  const peers = [
    peer({ id: '2', agentId: 2 }),
    peer({ id: '3', agentId: 3 }),
    peer({ id: '4', agentId: 4 }),
    peer({ id: '5', agentId: 5, responseAuth: false }),
  ]
  const config = createDefaultConfig()
  config.payments.maxPerRequestUsdc = '100'
  let prepareCount = 0
  let epochReadCount = 0
  let submitCount = 0
  const proxyAuditNode = {} as VerifierRuntime['node']
  const proxyAddress = '0x9999999999999999999999999999999999999999'
  const proxyPeerId = '99'.repeat(20)
  const shared = reference()
  const observedReferences: KbfReferenceV1[] = []
  const runtime = {
    config,
    dataDir: dir,
    node: {
      discoverPeers: async () => peers,
      findPeer: async (peerId: string) => peers.find((item) => item.peerId === peerId) ?? null,
    },
    chain: {
      chain: {},
      registryClient: {
        currentEpoch: async () => {
          epochReadCount += 1
          return 7n
        },
        submitVerificationResult: async () => {
          submitCount += 1
          return '0xtx'
        },
      },
      rewardsClient: {},
    },
    identity: {
      peerId: VERIFIER_PEER_ID,
      wallet: { address: VERIFIER_ADDRESS },
    },
    storage,
    referencesDir: join(dir, 'references'),
    evidenceDir: join(dir, 'evidence'),
  } as unknown as VerifierRuntime

  try {
    const run = await runBenchmarkObservation(runtime, {
      service: SERVICE,
      probeCount: 100,
      maxTotalUsdc: 1000n,
      targetConcurrency: 2,
      probeConcurrency: 2,
      epochSource: 'none',
    }, {
      now: () => NOW,
      nonce: () => 'nonce',
      executionTransport: {
        node: proxyAuditNode,
        verifierAddress: proxyAddress,
        verifierPeerId: proxyPeerId,
      },
      prepareReference: async (input): Promise<PreparedBenchmarkReference> => {
        prepareCount += 1
        assert.equal(input.sizing.mode, 'fixed')
        assert.equal(input.sizing.minimumProbeCount, 100)
        assert.equal(input.sizing.maximumProbeCount, 100)
        assert.equal(input.sizing.alpha, 0.05 / 3)
        assert.equal(input.sizing.cpConfidence, 0.99)
        return {
          reference: shared,
          outPath: join(dir, 'reference.json'),
          certificationHash: 'sha256:certification',
          queryProfileHash: 'sha256:profile',
          trust: 'smoke',
          contrastModels: ['kimi-k3'],
        }
      },
      executeObservation: async (context, input): Promise<DirectAuditObservationResult> => {
        assert.equal(context.node, proxyAuditNode)
        assert.equal(context.verifierAddress, proxyAddress)
        assert.equal(context.verifierPeerId, proxyPeerId)
        assert.equal(context.verdictAlpha, 0.05 / 3)
        assert.equal(context.verdictCpConfidence, 0.99)
        assert.equal(context.verdictMinCoverage, 1)
        assert.equal(context.minAuthenticatedProbeCount, 100)
        observedReferences.push(input.reference)
        const ticket = context.budget!.reserve(context.maxPerRequestUsdc!)
        context.onSpend?.(context.budget!.commit(ticket, 10n))
        const operationalFailure = input.target.onChainAgentId === 4
        return {
          runId: input.runId,
          auditId: `audit-${input.target.peerId}`,
          evidencePath: `/tmp/${input.target.peerId}.json`,
          evidenceHash: '0xhash',
          epoch: 7n,
          verdict: operationalFailure ? 3 : 1,
          verdictReason: operationalFailure ? 'malformed' : null,
          probeCount: 100,
          authenticatedProbeCount: 100,
          parsedProbeCount: operationalFailure ? 0 : 100,
          sellerChargeUsdc: 10n,
          exchanges: [{ status: operationalFailure ? 'failed' : 'succeeded', failureReason: operationalFailure ? 'malformed completion response' : null } as DirectAuditObservationResult['exchanges'][number]],
        }
      },
    })

    assert.equal(prepareCount, 1)
    assert.equal(epochReadCount, 0)
    assert.equal(observedReferences.length, 3)
    assert.equal(observedReferences.every((item) => item === shared), true)
    assert.equal(submitCount, 0)
    assert.equal(run.discoveredCount, 4)
    assert.equal(run.eligibleCount, 3)
    assert.equal(run.perPeerAlpha, 0.05 / 3)
    assert.equal(run.minimumTargetCoverage, 1)
    assert.equal(run.completedCount, 2)
    assert.equal(run.failedCount, 1)
    assert.equal(run.spentUsdc, '30')
    const targets = storage.listBenchmarkTargets(run.runId)
    assert.equal(targets.find((target) => target.agentId === '4')?.state, 'failed')
    assert.equal(targets.find((target) => target.agentId === '5')?.eligibility, 'ineligible')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('benchmark report and CSV include every participant without truncation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-benchmark-report-'))
  const storage = new VerificationStorage(join(dir, 'verification.db'))
  const run = { ...benchmarkRun('run-report'), discoveredCount: 30 }
  storage.saveBenchmarkRun(run)
  storage.saveBenchmarkTargets(Array.from({ length: 30 }, (_unused, index) => benchmarkTarget(run.runId, index + 1)))
  try {
    const report = await buildBenchmarkReport(storage, run.runId)
    assert.equal(report.participants.length, 30)
    assert.equal(report.summary.ineligible, 30)
    const csv = renderBenchmarkReport(report, 'csv')
    assert.equal(csv.split('\n').length, 31)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('benchmark attestation rejects audit ids outside the selected run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-benchmark-attest-'))
  const storage = new VerificationStorage(join(dir, 'verification.db'))
  const run = benchmarkRun('run-attest')
  storage.saveBenchmarkRun(run)
  try {
    await assert.rejects(attestBenchmarkAudits({
      runtime: { storage } as unknown as VerifierRuntime,
      runId: run.runId,
      auditIds: ['not-in-run'],
    }), /not a completed observation/)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('benchmark eligibility requires agent identity, response auth, service, and non-self target', () => {
  assert.deepEqual(classifyBenchmarkEligibility(peer({ id: '2', agentId: 2 }), VERIFIER_ADDRESS, SERVICE), { eligible: true })
  assert.match(ineligibleReason(classifyBenchmarkEligibility(peer({ id: '3' }), VERIFIER_ADDRESS, SERVICE)), /agent id/)
  assert.match(ineligibleReason(classifyBenchmarkEligibility(peer({ id: '4', agentId: 4, responseAuth: false }), VERIFIER_ADDRESS, SERVICE)), /response-auth/)
  assert.match(ineligibleReason(classifyBenchmarkEligibility(peer({ id: '5', agentId: 5, service: 'other' }), VERIFIER_ADDRESS, SERVICE)), /no longer advertised/)
  assert.match(ineligibleReason(classifyBenchmarkEligibility(peer({ id: '1', agentId: 1 }), VERIFIER_ADDRESS, SERVICE)), /self peer/)
})

function ineligibleReason(result: ReturnType<typeof classifyBenchmarkEligibility>): string {
  assert.equal(result.eligible, false)
  return result.reason
}
