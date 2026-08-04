import assert from 'node:assert/strict'
import test from 'node:test'
import {
  serviceHash,
  type PeerInfo,
  type StoredBenchmarkRun,
} from '@antseed/node'
import { createDefaultConfig } from '../../../config/defaults.js'
import { SellerBackoff } from '../../../verifier/backoff.js'
import type { DirectAuditResult } from '../../../verifier/audit-runner.js'
import type { BenchmarkReportV1 } from '../../../verifier/benchmark.js'
import type { VerifierRuntime } from '../../../verifier/runtime.js'
import {
  executeObserveVerifierOnce,
  parseVerifierStartMode,
  resolveObserveBenchmarkOptions,
  runVerifierRound,
  type VerifierStartCommandOptions,
  type VerifierDaemonState,
  type VerifierRoundOverrides,
} from './start.js'

const NOW = 1_800_000_100_000
const VERIFIER_PEER_ID = '11'.repeat(20)
const VERIFIER_ADDRESS = `0x${VERIFIER_PEER_ID}`

function peer(peerId: string, agentId: number | undefined, services: string[]): PeerInfo {
  return {
    peerId: peerId as PeerInfo['peerId'],
    lastSeen: NOW,
    providers: ['mock'],
    ...(agentId === undefined ? {} : {
      onChainAgentId: agentId,
      onChainSellerAddress: `0x${peerId}`,
    }),
    metadata: {
      version: 1,
      peerId,
      displayName: `peer-${agentId ?? 'none'}`,
      timestamp: NOW,
      providers: [{ name: 'mock', services }],
    } as unknown as PeerInfo['metadata'],
  }
}

function auditResult(agentId: number, credited: boolean): DirectAuditResult {
  return {
    runId: `run-${agentId}`,
    auditId: `0x${agentId.toString(16).padStart(64, '0')}`,
    evidencePath: `/tmp/${agentId}.json`,
    evidenceHash: `0x${'22'.repeat(32)}`,
    attestationTxHash: `0x${'33'.repeat(32)}`,
    credited,
    epoch: 7n,
    verdict: 1,
    modelShareBps: 0,
    probeCount: 100,
    authenticatedProbeCount: 100,
    parsedProbeCount: 100,
    exchanges: [],
  }
}

function runtime(options: {
  credits?: bigint
  onChainLimit?: number
  localAuditCount?: number
  lastCreditedAt?: (agentId: number, targetServiceHash: string) => number
} = {}): VerifierRuntime {
  const config = createDefaultConfig()
  config.verifier = { ...config.verifier, maxAuditsPerEpoch: 50 }
  const registryClient = {
    currentEpoch: async () => 7n,
    currentEpochWindow: async () => ({ epoch: 7n, startedAt: 0, endsAt: 1 }),
    auditCooldown: async () => 86_400,
    maxCreditsPerVerifierPerEpoch: async () => options.onChainLimit ?? 100,
    minProbeCount: async () => 10,
    epochCredits: async () => options.credits ?? 0n,
    lastCreditedAt: async (agentId: number, targetServiceHash: string) => (
      options.lastCreditedAt?.(agentId, targetServiceHash) ?? 0
    ),
  }
  return {
    config,
    dataDir: '/tmp/verifier',
    node: {} as VerifierRuntime['node'],
    chain: {
      chain: {} as VerifierRuntime['chain']['chain'],
      registryClient: registryClient as unknown as VerifierRuntime['chain']['registryClient'],
      rewardsClient: {
        firstRewardedEpoch: async () => 7n,
      } as VerifierRuntime['chain']['rewardsClient'],
    },
    identity: {
      peerId: VERIFIER_PEER_ID,
      wallet: { address: VERIFIER_ADDRESS },
    } as VerifierRuntime['identity'],
    storage: {
      countDirectAuditsForEpoch: () => options.localAuditCount ?? 0,
      latestDirectAudit: () => null,
    } as unknown as VerifierRuntime['storage'],
    referencesDir: '/tmp/references',
    evidenceDir: '/tmp/evidence',
  }
}

function overrides(peers: PeerInfo[], executeAudit: VerifierRoundOverrides['executeAudit']): VerifierRoundOverrides {
  return {
    discoverPeers: async () => peers,
    executeAudit,
    now: () => NOW,
    log: () => {},
    warn: () => {},
  }
}

function observeOptions(
  overrides: Partial<VerifierStartCommandOptions> = {},
): VerifierStartCommandOptions {
  return {
    mode: 'observe',
    once: true,
    service: ['gpt-5.6-sol'],
    probes: 100,
    maxTotalUsdc: 5_000_000n,
    targetConcurrency: 2,
    probeConcurrency: 2,
    ...overrides,
  }
}

test('observe mode parsing rejects ambiguous daemon modes', () => {
  assert.equal(parseVerifierStartMode('observe'), 'observe')
  assert.equal(parseVerifierStartMode(' ATTEST '), 'attest')
  assert.throws(() => parseVerifierStartMode('dry-run'), /attest or observe/)
})

test('observe mode requires one-shot execution, one service, and a positive cap', () => {
  assert.throws(
    () => resolveObserveBenchmarkOptions(observeOptions({ once: false })),
    /requires --once/,
  )
  assert.throws(
    () => resolveObserveBenchmarkOptions(observeOptions({ service: undefined })),
    /exactly one --service/,
  )
  assert.throws(
    () => resolveObserveBenchmarkOptions(observeOptions({ service: ['a', 'b'] })),
    /exactly one --service/,
  )
  assert.throws(
    () => resolveObserveBenchmarkOptions(observeOptions({ maxTotalUsdc: undefined })),
    /requires --max-total-usdc/,
  )
  assert.throws(
    () => resolveObserveBenchmarkOptions(observeOptions({ maxTotalUsdc: 0n })),
    /greater than zero/,
  )
})

test('observe mode maps daemon flags to a registry-free benchmark run', () => {
  assert.deepEqual(resolveObserveBenchmarkOptions(observeOptions()), {
    service: 'gpt-5.6-sol',
    probeCount: 100,
    maxTotalUsdc: 5_000_000n,
    targetConcurrency: 2,
    probeConcurrency: 2,
    epochSource: 'none',
  })
})

test('observe mode executes benchmark analytics and builds the complete report', async () => {
  const verifierRuntime = runtime()
  const benchmarkOptions = resolveObserveBenchmarkOptions(observeOptions())
  const expectedRun = { runId: 'run-observe' } as StoredBenchmarkRun
  const expectedReport = {
    version: 1,
    kind: 'antseed-kbf-benchmark-report',
    run: { runId: expectedRun.runId },
  } as BenchmarkReportV1
  let receivedOptions: typeof benchmarkOptions | null = null
  let reportRunId: string | null = null

  const result = await executeObserveVerifierOnce(verifierRuntime, benchmarkOptions, {
    runBenchmark: async (_runtime, options) => {
      receivedOptions = options
      return expectedRun
    },
    buildReport: async (_storage, runId) => {
      reportRunId = runId
      return expectedReport
    },
    log: () => {},
    warn: () => {},
  })

  assert.deepEqual(receivedOptions, benchmarkOptions)
  assert.equal(reportRunId, expectedRun.runId)
  assert.equal(result.run, expectedRun)
  assert.equal(result.report, expectedReport)
})

test('round filters services, self-audits, missing agents, and credited cooldowns', async () => {
  const eligible = peer('22'.repeat(20), 1, ['Service-A'])
  const coolingDown = peer('33'.repeat(20), 2, ['Service-A'])
  const self = peer(VERIFIER_PEER_ID, 3, ['Service-A'])
  const missingAgent = peer('44'.repeat(20), undefined, ['Service-A'])
  const otherService = peer('55'.repeat(20), 4, ['Service-B'])
  const calls: Array<{ peer: string; service: string }> = []
  const verifierRuntime = runtime({
    lastCreditedAt: (agentId, targetServiceHash) => (
      agentId === 2 && targetServiceHash === serviceHash('Service-A')
        ? Math.floor(NOW / 1_000) - 60
        : 0
    ),
  })
  const result = await runVerifierRound(
    verifierRuntime,
    { runningRound: false, stopping: false },
    new Set(['service-a']),
    overrides([eligible, coolingDown, self, missingAgent, otherService], async (input) => {
      calls.push({ peer: input.target.peerId, service: input.service })
      return auditResult(input.target.onChainAgentId!, true)
    }),
  )

  assert.equal(result.discoveredPeers, 5)
  assert.equal(result.eligibleTargets, 1)
  assert.equal(result.attemptedAudits, 1)
  assert.deepEqual(calls, [{ peer: eligible.peerId, service: 'Service-A' }])
})

test('round prevents overlap and stops at the on-chain credit cap', async () => {
  const verifierRuntime = runtime({ onChainLimit: 1 })
  const overlapping = await runVerifierRound(
    verifierRuntime,
    { runningRound: true, stopping: false },
  )
  assert.equal(overlapping.skippedOverlap, true)

  let calls = 0
  const state: VerifierDaemonState = { runningRound: false, stopping: false }
  const result = await runVerifierRound(
    verifierRuntime,
    state,
    new Set(),
    overrides([
      peer('22'.repeat(20), 1, ['service-a']),
      peer('33'.repeat(20), 2, ['service-a']),
    ], async (input) => {
      calls += 1
      return auditResult(input.target.onChainAgentId!, true)
    }),
  )
  assert.equal(calls, 1)
  assert.equal(result.creditedAudits, 1)
  assert.equal(result.limitReached, true)
  assert.equal(state.runningRound, false)
})

test('round respects the local epoch cap before discovery', async () => {
  const verifierRuntime = runtime({ localAuditCount: 1 })
  verifierRuntime.config.verifier = { ...verifierRuntime.config.verifier, maxAuditsPerEpoch: 1 }
  let discovered = false
  const result = await runVerifierRound(
    verifierRuntime,
    { runningRound: false, stopping: false },
    new Set(),
    {
      discoverPeers: async () => {
        discovered = true
        return []
      },
      log: () => {},
      warn: () => {},
    },
  )
  assert.equal(discovered, false)
  assert.equal(result.limitReached, true)
})

test('failed audits enter backoff and are skipped on the next round', async () => {
  const verifierRuntime = runtime()
  const seller = peer('22'.repeat(20), 1, ['service-a'])
  const backoff = new SellerBackoff({ baseCooldownMs: 60_000, maxCooldownMs: 60_000 })
  let calls = 0
  const roundOverrides = {
    ...overrides([seller], async () => {
      calls += 1
      throw new Error('seller unavailable')
    }),
    backoff,
  }
  const first = await runVerifierRound(
    verifierRuntime,
    { runningRound: false, stopping: false },
    new Set(),
    roundOverrides,
  )
  const second = await runVerifierRound(
    verifierRuntime,
    { runningRound: false, stopping: false },
    new Set(),
    roundOverrides,
  )
  assert.equal(first.failedAudits, 1)
  assert.equal(second.attemptedAudits, 0)
  assert.equal(calls, 1)
})
