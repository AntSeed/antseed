import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  KBF_PROBES_PER_REQUEST,
  canonicalHashBytes32,
  validateKbfReferenceV1,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  peerIdToAddress,
  type PeerInfo,
  type StoredBenchmarkRun,
  type StoredBenchmarkTarget,
  type VerificationStorage,
} from '@antseed/node'
import {
  attestCompletedDirectAudit,
  executeDirectAuditObservation,
  type DirectAuditNode,
  type DirectAuditObservationResult,
  type DirectAuditResult,
} from './audit-runner.js'
import { UsdcBudget } from './benchmark-budget.js'
import {
  prepareBenchmarkReference,
  type PreparedBenchmarkReference,
} from './benchmark-reference.js'
import { verifyDirectAuditEvidenceFile } from './direct-evidence.js'
import { resolveReferencePolicy } from './reference-config.js'
import { advertisedServices, discoverServices } from './service-discovery.js'
import type { VerifierRuntime } from './runtime.js'

export interface BenchmarkRunOptions {
  service: string
  probeCount: number | 'auto'
  maxTotalUsdc: bigint
  targetConcurrency: number
  probeConcurrency: number
  epochSource?: 'registry' | 'none'
  dryRun?: boolean
  resumeRunId?: string
}

export interface BenchmarkReportV1 {
  version: 1
  kind: 'antseed-kbf-benchmark-report'
  run: {
    runId: string
    mode: 'observe'
    service: string
    epoch: string | null
    createdAt: string
    completedAt: string | null
    referenceId: string
    referenceTrust: 'smoke' | 'trusted'
    probeSizingMode: 'fixed' | 'auto'
    probeCount: number
    spentUsdc: string
    maxTotalUsdc: string
  }
  reference: {
    model: string
    contrastModels: string[]
    queryProfileHash: string
    selfHamming: number
    selfTotal: number
    selfErrorRate: number
    statisticalPower: number
    familyWideAlpha: number | null
    perPeerAlpha: number | null
    minimumMismatchDelta: number | null
    referenceConfidence: number | null
    minimumStatisticalPower: number | null
    referenceErrorUpperBound: number | null
    criticalMismatchCount: number | null
    minimumTargetCoverage: number | null
  }
  summary: {
    discovered: number
    eligible: number
    same: number
    diff: number
    undetermined: number
    failed: number
    ineligible: number
  }
  participants: BenchmarkParticipantReport[]
}

export interface BenchmarkParticipantReport {
  ordinal: number
  peerId: string
  displayName: string | null
  agentId: string | null
  advertisedService: string
  status: 'SAME' | 'DIFF' | 'UNDETERMINED' | 'FAILED' | 'INELIGIBLE'
  reason: string | null
  auditId: string | null
  coverage: number | null
  hammingErrors: number | null
  observedErrorRate: number | null
  referenceErrorUpperBound99: number | null
  oneSidedBinomialPValue: number | null
  modelShareBps: number | null
  authenticatedProbeCount: number
  probeCount: number
  sellerChargeUsdc: string
  p50TtftMs: number | null
  p95TtftMs: number | null
  p50OutputTokensPerSecondMilli: number | null
  evidencePath: string | null
  evidenceHash: string | null
  attestationTxHash: string | null
}

export interface BenchmarkExecutionTransport {
  node: DirectAuditNode
  verifierAddress: string
  verifierPeerId: string
}

interface RunBenchmarkDependencies {
  prepareReference?: typeof prepareBenchmarkReference
  executeObservation?: typeof executeDirectAuditObservation
  executionTransport?: BenchmarkExecutionTransport
  now?: () => number
  nonce?: () => string
  log?: (message: string) => void
  warn?: (message: string) => void
}

export function createBenchmarkRunId(input: {
  service: string
  epoch: bigint | null
  createdAt: number
  nonce?: string
}): string {
  return canonicalHashBytes32({
    domain: 'antseed-benchmark-run-v1',
    service: input.service.trim().toLowerCase(),
    epoch: input.epoch?.toString() ?? null,
    createdAt: input.createdAt,
    nonce: input.nonce ?? randomUUID(),
  })
}

export function createBenchmarkTargetAuditId(input: {
  runId: string
  peerId: string
  agentId: string
  service: string
}): string {
  return canonicalHashBytes32({
    domain: 'antseed-benchmark-target-v1',
    benchmarkRunId: input.runId,
    peerId: input.peerId,
    agentId: input.agentId,
    service: input.service.trim().toLowerCase(),
  })
}

export function classifyBenchmarkEligibility(
  peer: PeerInfo,
  verifierAddress: string,
  normalizedService = 'gpt-5.6-sol',
): { eligible: true } | { eligible: false; reason: string } {
  if (!peer.onChainAgentId) return { eligible: false, reason: 'missing on-chain agent id' }
  if (peerIdToAddress(peer.peerId).toLowerCase() === verifierAddress.toLowerCase()) {
    return { eligible: false, reason: 'self peer' }
  }
  if (!peer.capabilities?.includes(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1)) {
    return { eligible: false, reason: 'missing verification.response-auth.v1' }
  }
  if (!advertisedServices(peer).has(normalizedService)) {
    return { eligible: false, reason: 'service no longer advertised' }
  }
  return { eligible: true }
}

export function estimateBenchmarkMaximumSpend(input: {
  eligibleCount: number
  probeCount: number
  maxPerRequestUsdc: bigint
  maxTotalUsdc: bigint
}): bigint {
  const requestCount = BigInt(input.eligibleCount * Math.ceil(input.probeCount / KBF_PROBES_PER_REQUEST))
  const requestMaximum = requestCount * input.maxPerRequestUsdc
  return requestMaximum < input.maxTotalUsdc ? requestMaximum : input.maxTotalUsdc
}

export async function runBenchmarkObservation(
  runtime: VerifierRuntime,
  options: BenchmarkRunOptions,
  dependencies: RunBenchmarkDependencies = {},
): Promise<StoredBenchmarkRun> {
  validateBenchmarkOptions(options)
  const normalizedService = options.service.trim().toLowerCase()
  const executionTransport = dependencies.executionTransport ?? {
    node: runtime.node,
    verifierAddress: runtime.identity.wallet.address,
    verifierPeerId: runtime.identity.peerId,
  }
  const now = dependencies.now ?? Date.now
  const epoch = options.resumeRunId
    || options.epochSource === 'none'
    || !runtime.chain.chain.verifierRegistryAddress
    ? null
    : await runtime.chain.registryClient.currentEpoch()
  const createdAt = now()
  const policy = resolveReferencePolicy(runtime.config.verifier?.referencePolicy)
  let run = options.resumeRunId
    ? requireBenchmarkRun(runtime.storage, options.resumeRunId)
    : createBenchmarkRun({
      runId: createBenchmarkRunId({
        service: normalizedService,
        epoch,
        createdAt,
        nonce: dependencies.nonce?.(),
      }),
      service: normalizedService,
      epoch: epoch?.toString() ?? null,
      probeCount: options.probeCount,
      policy,
      maxTotalUsdc: options.maxTotalUsdc,
      createdAt,
    })

  if (options.resumeRunId) assertResumeOptions(run, options, normalizedService)
  else runtime.storage.saveBenchmarkRun(run)

  try {
    let targets = runtime.storage.listBenchmarkTargets(run.runId)
    let peersById = new Map<string, PeerInfo>()
    if (targets.length === 0) {
      const peers = await runtime.node.discoverPeers()
      const group = discoverServices(peers).find((entry) => entry.service === normalizedService)
      const discovered = group?.peers ?? []
      peersById = new Map(discovered.map((peer) => [peer.peerId, peer]))
      targets = snapshotBenchmarkTargets({
        runId: run.runId,
        peers: discovered,
        verifierAddress: executionTransport.verifierAddress,
        normalizedService,
        now: now(),
      })
      runtime.storage.saveBenchmarkTargets(targets)
      run = runtime.storage.updateBenchmarkRun(run.runId, {
        discoveredCount: targets.length,
        eligibleCount: targets.filter((target) => target.eligibility === 'eligible').length,
        perPeerAlpha: run.familyWideAlpha! / Math.max(1, targets.filter((target) => target.eligibility === 'eligible').length),
        updatedAt: now(),
      })
    } else {
      targets = recoverCompletedTargets(runtime.storage, targets, now())
      updateBenchmarkCounts(runtime.storage, run.runId, now())
    }

    if (options.dryRun) {
      for (const target of targets) {
        if (target.eligibility === 'eligible' && target.state !== 'completed') {
          runtime.storage.updateBenchmarkTarget(run.runId, target.peerId, {
            state: 'skipped',
            eligibilityReason: 'dry run; no probes sent',
            updatedAt: now(),
          })
        }
      }
      return runtime.storage.updateBenchmarkRun(run.runId, {
        state: 'completed',
        completedAt: now(),
        updatedAt: now(),
      })
    }

    run = runtime.storage.updateBenchmarkRun(run.runId, {
      state: 'preparing',
      failureReason: null,
      updatedAt: now(),
    })
    const prepared = run.referencePath
      ? await loadPreparedReference(run)
      : await (dependencies.prepareReference ?? prepareBenchmarkReference)({
        storage: runtime.storage,
        runId: run.runId,
        service: normalizedService,
        verifierConfig: runtime.config.verifier,
        referencesDir: runtime.referencesDir,
        sizing: benchmarkReferenceSizing(run),
        now: run.createdAt,
        ...(dependencies.log ? { log: dependencies.log } : {}),
      })
    run = runtime.storage.updateBenchmarkRun(run.runId, {
      state: 'running',
      referenceId: prepared.reference.referenceId,
      certificationHash: prepared.certificationHash,
      queryProfileHash: prepared.queryProfileHash,
      probeCount: prepared.reference.selectedProbeCount,
      achievedStatisticalPower: prepared.reference.statisticalPower,
      referenceErrorUpperBound: prepared.reference.statisticalPowerEvidence.p0UpperBound,
      criticalMismatchCount: prepared.reference.statisticalPowerEvidence.criticalMismatchCount,
      referencePath: prepared.outPath,
      updatedAt: now(),
    })

    if (peersById.size === 0) {
      const currentPeers = await runtime.node.discoverPeers(normalizedService)
      peersById = new Map(currentPeers.map((peer) => [peer.peerId, peer]))
    }

    const maximumPerRequest = BigInt(runtime.config.payments.maxPerRequestUsdc ?? '300000')
    const budget = new UsdcBudget(options.maxTotalUsdc, BigInt(run.spentUsdc))
    const executeObservation = dependencies.executeObservation ?? executeDirectAuditObservation
    const runnable = targets.filter((target) => target.eligibility === 'eligible' && target.state !== 'completed')

    await runConcurrently(runnable, options.targetConcurrency, async (target) => {
      const peer = peersById.get(target.peerId) ?? await runtime.node.findPeer(target.peerId)
      if (!peer) {
        updateFailedTarget(runtime.storage, target, 'peer is no longer discoverable', now())
        updateBenchmarkCounts(runtime.storage, run.runId, now())
        return
      }
      if (String(peer.onChainAgentId ?? '') !== target.agentId) {
        updateFailedTarget(runtime.storage, target, 'on-chain agent id changed after discovery snapshot', now())
        updateBenchmarkCounts(runtime.storage, run.runId, now())
        return
      }
      const advertisedService = advertisedServices(peer).get(normalizedService)
      if (!advertisedService) {
        updateFailedTarget(runtime.storage, target, 'service no longer advertised', now())
        updateBenchmarkCounts(runtime.storage, run.runId, now())
        return
      }

      const auditRunId = createBenchmarkTargetAuditId({
        runId: run.runId,
        peerId: target.peerId,
        agentId: target.agentId!,
        service: normalizedService,
      })
      runtime.storage.updateBenchmarkTarget(run.runId, target.peerId, {
        state: 'running',
        auditId: auditRunId,
        failureReason: null,
        updatedAt: now(),
      })

      try {
        const result = await executeObservation({
          node: executionTransport.node,
          storage: runtime.storage,
          verifierAddress: executionTransport.verifierAddress,
          verifierPeerId: executionTransport.verifierPeerId,
          evidenceDir: runtime.evidenceDir,
          minAuthenticatedProbeCount: Math.ceil(run.probeCount * (run.minimumTargetCoverage ?? 1)),
          minimumStatisticalPower: run.minimumStatisticalPower ?? policy.minimumStatisticalPower,
          verdictAlpha: run.perPeerAlpha ?? prepared.reference.statisticalPowerEvidence.alpha,
          verdictCpConfidence: run.referenceConfidence
            ?? prepared.reference.statisticalPowerEvidence.clopperPearsonConfidence,
          verdictMinCoverage: run.minimumTargetCoverage ?? policy.minimumAuthenticatedCoverage,
          probeRequestTimeoutMs: runtime.config.verifier?.probeRequestTimeoutMs ?? 120_000,
          maxConcurrentProbeRequests: options.probeConcurrency,
          maxPerRequestUsdc: maximumPerRequest,
          budget,
          onSpend: (totalSpent) => {
            runtime.storage.updateBenchmarkRun(run.runId, {
              spentUsdc: totalSpent.toString(),
              updatedAt: now(),
            })
          },
          ...(dependencies.warn ? { warn: dependencies.warn } : {}),
        }, {
          runId: auditRunId,
          source: 'automatic',
          epoch: BigInt(run.epoch ?? '0'),
          target: peer,
          service: advertisedService,
          reference: prepared.reference,
        })
        const failedExchange = result.exchanges.find((exchange) => exchange.status === 'failed')
        if (failedExchange) {
          updateFailedTarget(
            runtime.storage,
            target,
            failedExchange.failureReason ?? 'one or more probe batches failed',
            now(),
          )
        } else {
          updateCompletedTarget(runtime.storage, target, result, now())
        }
      } catch (error) {
        updateFailedTarget(runtime.storage, target, asError(error).message, now())
      }
      updateBenchmarkCounts(runtime.storage, run.runId, now())
    })

    const counts = targetCounts(runtime.storage.listBenchmarkTargets(run.runId))
    return runtime.storage.updateBenchmarkRun(run.runId, {
      state: 'completed',
      spentUsdc: budget.getSpent().toString(),
      completedCount: counts.completed,
      failedCount: counts.failed,
      completedAt: now(),
      updatedAt: now(),
    })
  } catch (error) {
    runtime.storage.updateBenchmarkRun(run.runId, {
      state: 'failed',
      failureReason: asError(error).message,
      updatedAt: now(),
    })
    throw error
  }
}

export async function buildBenchmarkReport(
  storage: VerificationStorage,
  runId: string,
): Promise<BenchmarkReportV1> {
  const run = requireBenchmarkRun(storage, runId)
  const reference = run.referencePath ? await readReference(run.referencePath) : null
  const participants = await Promise.all(storage.listBenchmarkTargets(runId).map(async (target) => {
    return buildParticipantReport(storage, target)
  }))
  const summary = {
    discovered: participants.length,
    eligible: participants.filter((participant) => participant.status !== 'INELIGIBLE').length,
    same: participants.filter((participant) => participant.status === 'SAME').length,
    diff: participants.filter((participant) => participant.status === 'DIFF').length,
    undetermined: participants.filter((participant) => participant.status === 'UNDETERMINED').length,
    failed: participants.filter((participant) => participant.status === 'FAILED').length,
    ineligible: participants.filter((participant) => participant.status === 'INELIGIBLE').length,
  }
  const trust = referenceTrust(reference)
  return {
    version: 1,
    kind: 'antseed-kbf-benchmark-report',
    run: {
      runId: run.runId,
      mode: 'observe',
      service: run.service,
      epoch: run.epoch,
      createdAt: new Date(run.createdAt).toISOString(),
      completedAt: run.completedAt === null ? null : new Date(run.completedAt).toISOString(),
      referenceId: run.referenceId ?? '',
      referenceTrust: trust,
      probeSizingMode: run.probeSizingMode,
      probeCount: run.probeCount,
      spentUsdc: run.spentUsdc,
      maxTotalUsdc: run.maxTotalUsdc,
    },
    reference: {
      model: reference?.referenceModel ?? run.service,
      contrastModels: reference?.contrasts.map((contrast) => contrast.model) ?? [],
      queryProfileHash: run.queryProfileHash ?? '',
      selfHamming: reference?.selfTest.hamming ?? 0,
      selfTotal: reference?.selfTest.total ?? 0,
      selfErrorRate: reference?.selfTest.errorRate ?? 0,
      statisticalPower: reference?.statisticalPower ?? 0,
      familyWideAlpha: run.familyWideAlpha,
      perPeerAlpha: run.perPeerAlpha,
      minimumMismatchDelta: run.minimumMismatchDelta,
      referenceConfidence: run.referenceConfidence,
      minimumStatisticalPower: run.minimumStatisticalPower,
      referenceErrorUpperBound: run.referenceErrorUpperBound,
      criticalMismatchCount: run.criticalMismatchCount,
      minimumTargetCoverage: run.minimumTargetCoverage,
    },
    summary,
    participants,
  }
}

export async function attestBenchmarkAudits(input: {
  runtime: VerifierRuntime
  runId: string
  auditIds: readonly string[]
  evidenceUriBase?: string
  warn?: (message: string) => void
}): Promise<DirectAuditResult[]> {
  requireBenchmarkRun(input.runtime.storage, input.runId)
  const targets = input.runtime.storage.listBenchmarkTargets(input.runId)
  const allowed = new Set(targets.filter((target) => target.state === 'completed' && target.auditId).map((target) => target.auditId!))
  const uniqueAuditIds = [...new Set(input.auditIds)]
  for (const auditId of uniqueAuditIds) {
    if (!allowed.has(auditId)) throw new Error(`audit ${auditId} is not a completed observation in benchmark ${input.runId}`)
  }

  const results: DirectAuditResult[] = []
  for (const auditId of uniqueAuditIds) {
    const evidenceUri = input.evidenceUriBase
      ? `${input.evidenceUriBase.replace(/\/+$/, '')}/${auditId}.json`
      : undefined
    results.push(await attestCompletedDirectAudit({
      registryClient: input.runtime.chain.registryClient,
      storage: input.runtime.storage,
      signer: input.runtime.identity.wallet,
      ...(input.warn ? { warn: input.warn } : {}),
    }, auditId, evidenceUri))
  }
  return results
}

function createBenchmarkRun(input: {
  runId: string
  service: string
  epoch: string | null
  probeCount: number | 'auto'
  policy: ReturnType<typeof resolveReferencePolicy>
  maxTotalUsdc: bigint
  createdAt: number
}): StoredBenchmarkRun {
  const fixedProbeCount = typeof input.probeCount === 'number' ? input.probeCount : null
  const minimumProbeCount = fixedProbeCount ?? input.policy.minimumAuditProbeCount
  const maximumProbeCount = fixedProbeCount ?? input.policy.maximumAuditProbeCount
  return {
    runId: input.runId,
    state: 'planned',
    mode: 'observe',
    service: input.service,
    epoch: input.epoch,
    referenceId: null,
    certificationHash: null,
    queryProfileHash: null,
    probeSizingMode: fixedProbeCount === null ? 'auto' : 'fixed',
    probeCount: minimumProbeCount,
    minimumProbeCount,
    maximumProbeCount,
    probeStep: fixedProbeCount === null ? input.policy.auditProbeStep : minimumProbeCount,
    familyWideAlpha: input.policy.familyWideAlpha,
    perPeerAlpha: null,
    minimumMismatchDelta: input.policy.minimumMismatchDelta,
    referenceConfidence: input.policy.referenceConfidence,
    minimumStatisticalPower: input.policy.minimumStatisticalPower,
    achievedStatisticalPower: null,
    referenceErrorUpperBound: null,
    criticalMismatchCount: null,
    minimumTargetCoverage: input.policy.minimumAuthenticatedCoverage,
    maxTotalUsdc: input.maxTotalUsdc.toString(),
    spentUsdc: '0',
    discoveredCount: 0,
    eligibleCount: 0,
    completedCount: 0,
    failedCount: 0,
    referencePath: null,
    failureReason: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: null,
  }
}

function snapshotBenchmarkTargets(input: {
  runId: string
  peers: readonly PeerInfo[]
  verifierAddress: string
  normalizedService: string
  now: number
}): StoredBenchmarkTarget[] {
  return [...input.peers]
    .sort((left, right) => canonicalHashBytes32(`${input.runId}:${left.peerId}`).localeCompare(
      canonicalHashBytes32(`${input.runId}:${right.peerId}`),
    ))
    .map((peer, index) => {
      const eligibility = classifyBenchmarkEligibility(peer, input.verifierAddress, input.normalizedService)
      return {
        runId: input.runId,
        ordinal: index + 1,
        peerId: peer.peerId,
        agentId: peer.onChainAgentId ? String(peer.onChainAgentId) : null,
        displayName: peer.displayName ?? null,
        publicAddress: peer.publicAddress ?? null,
        advertisedService: advertisedServices(peer).get(input.normalizedService) ?? input.normalizedService,
        eligibility: eligibility.eligible ? 'eligible' : 'ineligible',
        state: eligibility.eligible ? 'pending' : 'skipped',
        eligibilityReason: eligibility.eligible ? null : eligibility.reason,
        auditId: null,
        sellerChargeUsdc: '0',
        failureReason: null,
        createdAt: input.now,
        updatedAt: input.now,
      }
    })
}

async function loadPreparedReference(run: StoredBenchmarkRun): Promise<PreparedBenchmarkReference> {
  if (!run.referencePath || !run.certificationHash || !run.queryProfileHash) {
    throw new Error(`benchmark ${run.runId} has incomplete stored reference metadata`)
  }
  const reference = await readReference(run.referencePath)
  if (run.referenceId && reference.referenceId !== run.referenceId) {
    throw new Error(`benchmark ${run.runId} stored reference id does not match ${run.referencePath}`)
  }
  return {
    reference,
    outPath: run.referencePath,
    certificationHash: run.certificationHash,
    queryProfileHash: run.queryProfileHash,
    trust: referenceTrust(reference),
    contrastModels: reference.contrasts.map((contrast) => contrast.model),
  }
}

async function readReference(path: string): Promise<KbfReferenceV1> {
  return validateKbfReferenceV1(JSON.parse(await readFile(path, 'utf8')))
}

async function buildParticipantReport(
  storage: VerificationStorage,
  target: StoredBenchmarkTarget,
): Promise<BenchmarkParticipantReport> {
  const base = {
    ordinal: target.ordinal,
    peerId: target.peerId,
    displayName: target.displayName,
    agentId: target.agentId,
    advertisedService: target.advertisedService,
    auditId: target.auditId,
    sellerChargeUsdc: target.sellerChargeUsdc,
  }
  if (target.eligibility === 'ineligible') {
    return emptyParticipant(base, 'INELIGIBLE', target.eligibilityReason)
  }
  if (target.state === 'skipped') {
    return emptyParticipant(base, 'UNDETERMINED', target.eligibilityReason ?? 'observation skipped')
  }
  if (target.state !== 'completed' || !target.auditId) {
    return emptyParticipant(base, 'FAILED', target.failureReason ?? `target state is ${target.state}`)
  }
  const audit = storage.getDirectAudit(target.auditId)
  if (!audit || !audit.evidencePath || !audit.evidenceHash) {
    return emptyParticipant(base, 'FAILED', 'completed target has no canonical evidence')
  }
  try {
    const evidence = await verifyDirectAuditEvidenceFile(audit.evidencePath, audit.evidenceHash)
    const status = evidence.result.verdict === 'SAME'
      ? 'SAME'
      : evidence.result.verdict === 'DIFF'
        ? 'DIFF'
        : 'UNDETERMINED'
    const targetTotal = evidence.result.stats.targetTotal
    const targetHamming = evidence.result.stats.targetHamming
    return {
      ...base,
      status,
      reason: status === 'DIFF'
        ? 'GPT Sol model-mismatch signal'
        : evidence.result.verdictReason,
      coverage: evidence.result.stats.targetCoverage,
      hammingErrors: targetHamming,
      observedErrorRate: targetHamming === null || targetTotal === null || targetTotal === 0
        ? null
        : targetHamming / targetTotal,
      referenceErrorUpperBound99: evidence.result.stats.p0Cp99,
      oneSidedBinomialPValue: evidence.result.stats.pValueBinomial,
      modelShareBps: audit.modelShareBps,
      authenticatedProbeCount: evidence.result.authenticatedProbeCount,
      probeCount: evidence.result.selectedProbeCount,
      p50TtftMs: evidence.metrics.p50TtftMs,
      p95TtftMs: evidence.metrics.p95TtftMs,
      p50OutputTokensPerSecondMilli: evidence.metrics.p50OutputTokensPerSecondMilli,
      evidencePath: audit.evidencePath,
      evidenceHash: audit.evidenceHash,
      attestationTxHash: audit.attestationTxHash,
    }
  } catch (error) {
    return emptyParticipant(base, 'FAILED', `evidence verification failed: ${asError(error).message}`)
  }
}

function emptyParticipant(
  base: Pick<BenchmarkParticipantReport, 'ordinal' | 'peerId' | 'displayName' | 'agentId' | 'advertisedService' | 'auditId' | 'sellerChargeUsdc'>,
  status: BenchmarkParticipantReport['status'],
  reason: string | null,
): BenchmarkParticipantReport {
  return {
    ...base,
    status,
    reason,
    coverage: null,
    hammingErrors: null,
    observedErrorRate: null,
    referenceErrorUpperBound99: null,
    oneSidedBinomialPValue: null,
    modelShareBps: null,
    authenticatedProbeCount: 0,
    probeCount: 0,
    p50TtftMs: null,
    p95TtftMs: null,
    p50OutputTokensPerSecondMilli: null,
    evidencePath: null,
    evidenceHash: null,
    attestationTxHash: null,
  }
}

function updateCompletedTarget(
  storage: VerificationStorage,
  target: StoredBenchmarkTarget,
  result: DirectAuditObservationResult,
  now: number,
): void {
  storage.updateBenchmarkTarget(target.runId, target.peerId, {
    state: 'completed',
    auditId: result.auditId,
    sellerChargeUsdc: result.sellerChargeUsdc.toString(),
    failureReason: null,
    updatedAt: now,
  })
}

function updateFailedTarget(
  storage: VerificationStorage,
  target: StoredBenchmarkTarget,
  reason: string,
  now: number,
): void {
  storage.updateBenchmarkTarget(target.runId, target.peerId, {
    state: 'failed',
    failureReason: reason,
    updatedAt: now,
  })
}

function updateBenchmarkCounts(storage: VerificationStorage, runId: string, now: number): void {
  const counts = targetCounts(storage.listBenchmarkTargets(runId))
  storage.updateBenchmarkRun(runId, {
    completedCount: counts.completed,
    failedCount: counts.failed,
    updatedAt: now,
  })
}

function recoverCompletedTargets(
  storage: VerificationStorage,
  targets: readonly StoredBenchmarkTarget[],
  now: number,
): StoredBenchmarkTarget[] {
  return targets.map((target) => {
    if (target.state === 'completed' || !target.auditId) return target
    const audit = storage.getDirectAudit(target.auditId)
    if (!audit || (audit.state !== 'completed' && audit.state !== 'attested')) return target
    const sellerChargeUsdc = storage.listDirectAuditExchanges(target.auditId)
      .reduce((total, exchange) => total + BigInt(exchange.sellerChargeUsdc), 0n)
      .toString()
    return storage.updateBenchmarkTarget(target.runId, target.peerId, {
      state: 'completed',
      sellerChargeUsdc,
      failureReason: null,
      updatedAt: now,
    })
  })
}

function targetCounts(targets: readonly StoredBenchmarkTarget[]): { completed: number; failed: number } {
  return {
    completed: targets.filter((target) => target.state === 'completed').length,
    failed: targets.filter((target) => target.state === 'failed').length,
  }
}

function requireBenchmarkRun(storage: VerificationStorage, runId: string): StoredBenchmarkRun {
  const run = storage.getBenchmarkRun(runId)
  if (!run) throw new Error(`unknown benchmark run ${runId}`)
  return run
}

function assertResumeOptions(run: StoredBenchmarkRun, options: BenchmarkRunOptions, service: string): void {
  if (run.service !== service) throw new Error(`benchmark ${run.runId} service is ${run.service}, not ${service}`)
  if (options.probeCount === 'auto' && run.probeSizingMode !== 'auto') {
    throw new Error(`benchmark ${run.runId} uses fixed probe sizing`)
  }
  if (typeof options.probeCount === 'number' && (run.probeSizingMode !== 'fixed' || run.probeCount !== options.probeCount)) {
    throw new Error(`benchmark ${run.runId} probe count is ${run.probeCount}, not ${options.probeCount}`)
  }
  if (run.maxTotalUsdc !== options.maxTotalUsdc.toString()) {
    throw new Error(`benchmark ${run.runId} maximum USDC is ${run.maxTotalUsdc}, not ${options.maxTotalUsdc}`)
  }
}

function validateBenchmarkOptions(options: BenchmarkRunOptions): void {
  if (!options.service.trim()) throw new Error('benchmark service must not be empty')
  if (options.probeCount !== 'auto'
    && (!Number.isInteger(options.probeCount) || options.probeCount < 10 || options.probeCount % 10 !== 0)) {
    throw new Error('benchmark probes must be a positive multiple of 10')
  }
  if (!Number.isInteger(options.targetConcurrency) || options.targetConcurrency < 1) {
    throw new Error('target concurrency must be a positive integer')
  }
  if (!Number.isInteger(options.probeConcurrency) || options.probeConcurrency < 1) {
    throw new Error('probe concurrency must be a positive integer')
  }
  if (options.maxTotalUsdc < 0n) throw new Error('maximum total USDC cannot be negative')
}

function benchmarkReferenceSizing(run: StoredBenchmarkRun) {
  if (run.perPeerAlpha === null) throw new Error(`benchmark ${run.runId} has no cohort alpha`)
  return {
    mode: run.probeSizingMode,
    minimumProbeCount: run.minimumProbeCount ?? run.probeCount,
    maximumProbeCount: run.maximumProbeCount ?? run.probeCount,
    probeStep: run.probeStep ?? 10,
    minimumStatisticalPower: run.minimumStatisticalPower ?? 0.9,
    minimumMismatchDelta: run.minimumMismatchDelta ?? 0.1,
    alpha: run.perPeerAlpha,
    cpConfidence: run.referenceConfidence ?? 0.99,
  } as const
}

function referenceTrust(reference: KbfReferenceV1 | null): 'smoke' | 'trusted' {
  const trust = reference?.provenance?.['trust'] ?? reference?.generator.params['trust']
  return trust === 'smoke' ? 'smoke' : 'trusted'
}

async function runConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      await worker(items[index]!)
    }
  })
  await Promise.all(workers)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
