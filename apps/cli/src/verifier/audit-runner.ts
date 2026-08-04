import { randomUUID } from 'node:crypto'
import type { AbstractSigner } from 'ethers'
import {
  KBF_PROBES_PER_REQUEST,
  KbfVerifier,
  buildKbfChatRequestBody,
  canonicalHashBytes32,
  computeMatchVector,
  parseKbfAnswers,
  queryProfileHash,
  type KbfProbe,
  type KbfReferenceV1,
  type MatchVector,
} from '@antseed/fingerprints'
import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
  hashRequest,
  hashResponse,
  serviceHash,
  toResponseAuthPayload,
  type AntseedNode,
  type AttestationSubmittedEvent,
  type BuyerResponsePaymentEvidence,
  type MetricSnapshot,
  type PeerInfo,
  type StoredDirectAudit,
  type StoredDirectAuditProbe,
  type StoredResponseAuth,
  type VerificationStorage,
  type VerifierRegistryClient,
  type VerifierVerdict,
} from '@antseed/node'
import {
  deriveDirectAuditId,
  directAuditEvidenceHash,
  writeDirectAuditEvidence,
  verifyDirectAuditEvidenceFile,
  type DirectAuditEvidenceExchange,
  type DirectAuditEvidenceV1,
} from './direct-evidence.js'
import {
  calculateTrafficShareBps,
  resolveAntscanTrafficShare,
  type ResolveTrafficShareInput,
  type TrafficShareSnapshot,
} from './traffic-share.js'

export interface DirectAuditNode {
  sendRequest: AntseedNode['sendRequest']
  waitForResponseAuth: AntseedNode['waitForResponseAuth']
  finalizeResponsePayment: AntseedNode['finalizeResponsePayment']
}

export interface DirectAuditBudget {
  reserve(maximumRequestCharge: bigint): number
  commit(ticket: number, actualCharge: bigint): bigint
  release(ticket: number): void
}

export interface DirectAuditExecutionContext {
  node: DirectAuditNode
  storage: VerificationStorage
  verifierAddress: string
  verifierPeerId: string
  evidenceDir: string
  minAuthenticatedProbeCount: number
  minimumStatisticalPower: number
  verdictAlpha?: number
  verdictCpConfidence?: number
  verdictMinCoverage?: number
  probeRequestTimeoutMs: number
  maxConcurrentProbeRequests: number
  maxPerRequestUsdc?: bigint
  budget?: DirectAuditBudget
  onSpend?: (totalSpent: bigint) => void
  now?: () => number
  warn?: (message: string) => void
  writeEvidence?: typeof writeDirectAuditEvidence
}

export interface DirectAuditAttestationContext {
  registryClient: VerifierRegistryClient
  storage: VerificationStorage
  signer: AbstractSigner
  warn?: (message: string) => void
  resolveTrafficShare?: (input: ResolveTrafficShareInput) => Promise<TrafficShareSnapshot>
  resolveSubmittedEvent?: (input: {
    txHash: string
    auditId: string
    agentId: number
    serviceHash: string
  }) => Promise<Pick<AttestationSubmittedEvent, 'credited' | 'epoch'> | null>
}

export interface DirectAuditContext extends DirectAuditExecutionContext, DirectAuditAttestationContext {}

export interface RunDirectAuditInput {
  runId: string
  source: 'manual' | 'automatic'
  epoch: bigint
  target: PeerInfo
  service: string
  reference: KbfReferenceV1
  evidenceUri?: string
}

export interface DirectAuditResult {
  runId: string
  auditId: string
  evidencePath: string
  evidenceHash: string
  attestationTxHash: string
  credited: boolean | null
  epoch: bigint
  verdict: Exclude<VerifierVerdict, 0>
  modelShareBps: number
  probeCount: number
  authenticatedProbeCount: number
  parsedProbeCount: number
  exchanges: DirectAuditEvidenceExchange[]
}

export interface DirectAuditObservationResult {
  runId: string
  auditId: string
  evidencePath: string
  evidenceHash: string
  epoch: bigint
  verdict: Exclude<VerifierVerdict, 0>
  verdictReason: string | null
  probeCount: number
  authenticatedProbeCount: number
  parsedProbeCount: number
  sellerChargeUsdc: bigint
  exchanges: DirectAuditEvidenceExchange[]
}

interface BatchExecution {
  batchIndex: number
  ordinalStart: number
  probes: KbfProbe[]
  exchange: DirectAuditEvidenceExchange
  authenticated: boolean
}

export function createDirectAuditRunId(input: {
  verifierAddress: string
  targetPeerId: string
  agentId: number
  service: string
  now?: number
  nonce?: string
}): string {
  return canonicalHashBytes32({
    domain: 'antseed-direct-audit-run-v1',
    verifierAddress: input.verifierAddress.toLowerCase(),
    targetPeerId: input.targetPeerId.toLowerCase(),
    agentId: input.agentId,
    service: input.service.trim().toLowerCase(),
    createdAt: input.now ?? Date.now(),
    nonce: input.nonce ?? randomUUID(),
  })
}

export function buildDirectAuditRequestBody(
  reference: KbfReferenceV1,
  service: string,
  probes: readonly KbfProbe[],
): Record<string, unknown> {
  return {
    ...buildKbfChatRequestBody(service, probes, {
      maxTokens: reference.queryProfile.maxTokensPerRequest,
    }),
    top_p: reference.queryProfile.generationSettings.topP,
    stream: false,
    n: 1,
    ...(reference.queryProfile.requestOverrides ?? {}),
  }
}

export function initializeDirectAudit(input: {
  storage: VerificationStorage
  runId: string
  source: 'manual' | 'automatic'
  epoch: bigint
  verifierAddress: string
  target: PeerInfo
  service: string
  now?: number
}): StoredDirectAudit {
  if (!input.target.onChainAgentId) throw new Error('target has no on-chain agent id')
  if (!input.target.onChainSellerAddress) throw new Error('target has no verified on-chain seller address')
  const now = input.now ?? Date.now()
  const existing = input.storage.getDirectAudit(input.runId)
  if (existing) return existing
  const audit: StoredDirectAudit = {
    auditId: input.runId,
    state: 'pending',
    source: input.source,
    epoch: input.epoch.toString(),
    verifierAddress: input.verifierAddress,
    agentId: String(input.target.onChainAgentId),
    sellerAddress: input.target.onChainSellerAddress,
    targetPeerId: input.target.peerId,
    targetService: input.service,
    targetServiceHash: serviceHash(input.service),
    referenceId: null,
    queryProfileHash: null,
    probeCount: 0,
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
  input.storage.saveDirectAudit(audit)
  return audit
}

export async function executeDirectAuditObservation(
  context: DirectAuditExecutionContext,
  input: RunDirectAuditInput,
): Promise<DirectAuditObservationResult> {
  if (!input.target.onChainAgentId) throw new Error('target has no on-chain agent id')
  if (!input.target.onChainSellerAddress) throw new Error('target has no verified on-chain seller address')
  const sellerAddress = input.target.onChainSellerAddress
  if (!Number.isInteger(context.minAuthenticatedProbeCount) || context.minAuthenticatedProbeCount < 1) {
    throw new Error('minAuthenticatedProbeCount must be a positive integer')
  }
  if (!Number.isInteger(context.maxConcurrentProbeRequests) || context.maxConcurrentProbeRequests < 1) {
    throw new Error('maxConcurrentProbeRequests must be a positive integer')
  }
  if (!Number.isInteger(context.probeRequestTimeoutMs) || context.probeRequestTimeoutMs < 1) {
    throw new Error('probeRequestTimeoutMs must be a positive integer')
  }
  if (input.reference.probes.length < context.minAuthenticatedProbeCount) {
    throw new Error(`reference has ${input.reference.probes.length} probes; ${context.minAuthenticatedProbeCount} required`)
  }
  if (input.reference.probes.length % KBF_PROBES_PER_REQUEST !== 0) {
    throw new Error(`reference probe count must be divisible by ${KBF_PROBES_PER_REQUEST}`)
  }
  if (input.reference.statisticalPower < context.minimumStatisticalPower) {
    throw new Error(
      `reference power ${input.reference.statisticalPower.toFixed(4)} is below ${context.minimumStatisticalPower}`,
    )
  }

  const now = context.now ?? Date.now
  const startedAt = now()
  initializeDirectAudit({
    storage: context.storage,
    runId: input.runId,
    source: input.source,
    epoch: input.epoch,
    verifierAddress: context.verifierAddress,
    target: input.target,
    service: input.service,
    now: startedAt,
  })
  const existingProbes = context.storage.listDirectAuditProbes(input.runId)
  if (existingProbes.length === 0) {
    const selectedProbes = input.reference.probes.map((probe, ordinal): StoredDirectAuditProbe => ({
      auditId: input.runId,
      ordinal,
      probeId: probe.id,
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
    }))
    context.storage.saveDirectAuditProbes(selectedProbes)
  } else {
    const expectedProbeIds = input.reference.probes.map((probe) => probe.id)
    const storedProbeIds = existingProbes.map((probe) => probe.probeId)
    if (JSON.stringify(storedProbeIds) !== JSON.stringify(expectedProbeIds)) {
      throw new Error(`stored probe selection for ${input.runId} does not match the supplied reference`)
    }
  }
  context.storage.updateDirectAudit(input.runId, 'running', {
    referenceId: input.reference.referenceId,
    queryProfileHash: queryProfileHash(input.reference.queryProfile),
    probeCount: input.reference.probes.length,
    statisticalPower: input.reference.statisticalPower,
    startedAt,
    failureReason: null,
  })

  let executions: BatchExecution[]
  try {
    executions = await executeProbeBatches(context, input)
  } catch (error) {
    context.storage.updateDirectAudit(input.runId, 'failed', {
      failureReason: asError(error).message,
      completedAt: now(),
    })
    throw error
  }

  const exchanges = executions.sort((left, right) => left.batchIndex - right.batchIndex).map((item) => item.exchange)
  const answers = exchanges.flatMap((exchange) => exchange.answers)
  const matchVector = computeMatchVector(answers, input.reference.probes)
  const authenticatedProbeCount = executions
    .filter((execution) => execution.authenticated)
    .reduce((sum, execution) => sum + execution.probes.length, 0)
  if (authenticatedProbeCount < context.minAuthenticatedProbeCount) {
    const message = `only ${authenticatedProbeCount} authenticated paid probes; ${context.minAuthenticatedProbeCount} required`
    context.storage.updateDirectAudit(input.runId, 'failed', {
      authenticatedProbeCount,
      completedAt: now(),
      failureReason: message,
    })
    throw new Error(message)
  }

  const fragment = new KbfVerifier().verify(input.reference, {
    sellerPeerId: input.target.peerId,
    agentId: input.target.onChainAgentId,
    answers,
    matchVector,
    requestIds: exchanges.map((exchange) => exchange.requestId),
    responseAuthHashes: exchanges.flatMap((exchange) => exchange.responseAuth
      ? [{ requestHash: exchange.responseAuth.requestHash, responseHash: exchange.responseAuth.responseHash }]
      : []),
  }, {
    alpha: context.verdictAlpha ?? input.reference.statisticalPowerEvidence.alpha,
    cpConfidence: context.verdictCpConfidence
      ?? input.reference.statisticalPowerEvidence.clopperPearsonConfidence,
    minCoverage: context.verdictMinCoverage,
  })
  if (fragment.verdict === 'UNKNOWN') {
    const message = fragment.verdictReason ?? 'KBF result is UNKNOWN'
    context.storage.updateDirectAudit(input.runId, 'failed', {
      authenticatedProbeCount,
      completedAt: now(),
      failureReason: message,
    })
    throw new Error(message)
  }

  const verdict = verdictCode(fragment.verdict)
  const completedAt = now()
  const metrics = buildMetricSnapshot(exchanges, startedAt, completedAt)
  const evidence: DirectAuditEvidenceV1 = {
    version: 1,
    kind: 'antseed-direct-kbf-audit',
    createdAt: new Date(completedAt).toISOString(),
    verifier: {
      peerId: context.verifierPeerId,
      address: context.verifierAddress,
    },
    target: {
      peerId: input.target.peerId,
      agentId: String(input.target.onChainAgentId),
      sellerAddress,
      service: input.service,
      serviceHash: serviceHash(input.service),
    },
    reference: {
      referenceId: input.reference.referenceId,
      referenceModel: input.reference.referenceModel,
      queryProfileHash: queryProfileHash(input.reference.queryProfile),
      queryProfile: input.reference.queryProfile,
      statisticalPower: input.reference.statisticalPower,
      statisticalPowerEvidence: input.reference.statisticalPowerEvidence as unknown as Record<string, unknown>,
      selfTest: {
        hamming: input.reference.selfTest.hamming,
        total: input.reference.selfTest.total,
        coverage: input.reference.selfTest.coverage,
        errorRate: input.reference.selfTest.errorRate,
      },
      probes: input.reference.probes,
    },
    exchanges,
    result: {
      selectedProbeCount: input.reference.probes.length,
      authenticatedProbeCount,
      parsedProbeCount: fragment.parsedProbeCount,
      matchVector: fragment.matchVector,
      matchVectorHash: fragment.matchVectorHash,
      stats: fragment.stats,
      verdict: fragment.verdict,
      verdictReason: fragment.verdictReason,
    },
    metrics,
  }
  const evidenceHash = directAuditEvidenceHash(evidence)
  const auditId = deriveDirectAuditId({
    verifierAddress: context.verifierAddress,
    targetPeerId: input.target.peerId,
    agentId: String(input.target.onChainAgentId),
    serviceHash: serviceHash(input.service),
    completedAt,
    evidenceHash,
  })

  const writer = context.writeEvidence ?? writeDirectAuditEvidence
  let evidencePath: string
  try {
    const written = await writer(context.evidenceDir, auditId, evidence)
    if (written.evidenceHash.toLowerCase() !== evidenceHash.toLowerCase()) {
      throw new Error('evidence writer returned a different content hash')
    }
    evidencePath = written.path
    context.storage.finalizeDirectAuditId(input.runId, auditId)
    context.storage.updateDirectAudit(auditId, 'completed', {
      authenticatedProbeCount,
      verdict,
      modelShareBps: null,
      metrics: metrics as unknown as Record<string, unknown>,
      evidencePath,
      evidenceHash,
      completedAt,
      failureReason: null,
    })
  } catch (error) {
    if (context.storage.getDirectAudit(input.runId)) {
      context.storage.updateDirectAudit(input.runId, 'failed', {
        authenticatedProbeCount,
        completedAt,
        failureReason: asError(error).message,
      })
    }
    throw error
  }

  return {
    runId: input.runId,
    auditId,
    evidencePath,
    evidenceHash,
    epoch: input.epoch,
    verdict,
    verdictReason: fragment.verdictReason,
    probeCount: input.reference.probes.length,
    authenticatedProbeCount,
    parsedProbeCount: fragment.parsedProbeCount,
    sellerChargeUsdc: exchanges.reduce(
      (total, exchange) => total + BigInt(exchange.payment?.sellerChargeUsdc ?? '0'),
      0n,
    ),
    exchanges,
  }
}

export async function attestCompletedDirectAudit(
  context: DirectAuditAttestationContext,
  auditId: string,
  evidenceUri?: string,
): Promise<DirectAuditResult> {
  const stored = context.storage.getDirectAudit(auditId)
  if (!stored || stored.state !== 'completed') {
    throw new Error(`audit ${auditId} is not ready for attestation`)
  }
  if (!stored.evidencePath || !stored.evidenceHash) {
    throw new Error(`audit ${auditId} has no canonical evidence`)
  }

  const evidence = await verifyDirectAuditEvidenceFile(stored.evidencePath, stored.evidenceHash)
  const verdict = verdictCode(evidence.result.verdict)
  let modelShareBps = 0
  let expectedEpoch: bigint
  try {
    if (verdict === VERIFIER_VERDICT_DIFF) {
      if (!stored.sellerAddress || stored.sellerAddress.toLowerCase() !== evidence.target.sellerAddress.toLowerCase()) {
        throw new Error(`audit ${auditId} has no consistent verified seller address`)
      }
      const epochWindow = await context.registryClient.currentEpochWindow()
      const resolveTrafficShare = context.resolveTrafficShare ?? resolveAntscanTrafficShare
      const snapshot = await resolveTrafficShare({
        sellerAddress: stored.sellerAddress,
        serviceHash: evidence.target.serviceHash,
        epochWindow,
      })
      assertTrafficShareSnapshot(snapshot, stored.sellerAddress, evidence.target.serviceHash, epochWindow)
      const currentWindow = await context.registryClient.currentEpochWindow()
      if (
        currentWindow.epoch !== epochWindow.epoch
        || currentWindow.startedAt !== epochWindow.startedAt
        || currentWindow.endsAt !== epochWindow.endsAt
      ) {
        throw new Error('verification epoch changed while calculating seller traffic share')
      }
      expectedEpoch = epochWindow.epoch
      modelShareBps = snapshot.modelShareBps
      context.storage.saveTrafficShareSnapshot({
        auditId,
        source: snapshot.source,
        epoch: snapshot.epoch.toString(),
        windowStartedAt: snapshot.windowStartedAt,
        windowEndedAt: snapshot.windowEndedAt,
        indexedBlock: snapshot.indexedBlock,
        sellerAddress: snapshot.sellerAddress,
        serviceHash: snapshot.serviceHash,
        serviceVolumeUsdc: snapshot.serviceVolumeUsdc.toString(),
        sellerVolumeUsdc: snapshot.sellerVolumeUsdc.toString(),
        modelShareBps,
        createdAt: Date.now(),
      })
      context.storage.updateDirectAudit(auditId, 'completed', {
        epoch: expectedEpoch.toString(),
        modelShareBps,
        failureReason: null,
      })
    } else {
      expectedEpoch = await context.registryClient.currentEpoch()
    }
  } catch (error) {
    context.storage.updateDirectAudit(auditId, 'completed', {
      failureReason: `verification result preparation failed: ${asError(error).message}`,
    })
    throw error
  }
  let attestationTxHash: string
  try {
    attestationTxHash = await context.registryClient.submitVerificationResult(context.signer, {
      auditId,
      agentId: BigInt(evidence.target.agentId),
      serviceHash: evidence.target.serviceHash,
      verdict,
      expectedEpoch,
      modelShareBps,
      probeCount: evidence.result.authenticatedProbeCount,
      metrics: evidence.metrics,
      evidenceHash: stored.evidenceHash,
    })
  } catch (error) {
    context.storage.updateDirectAudit(auditId, 'completed', {
      failureReason: `verification result failed: ${asError(error).message}`,
    })
    throw error
  }

  const submittedEvent = await resolveSubmittedEvent(context, {
    txHash: attestationTxHash,
    auditId,
    agentId: Number(evidence.target.agentId),
    serviceHash: evidence.target.serviceHash,
  }).catch((error) => {
    context.warn?.(`could not read attestation credit result for ${auditId}: ${asError(error).message}`)
    return null
  })
  const credited = submittedEvent?.credited ?? null
  const fallbackEpoch = stored.epoch === null ? await context.registryClient.currentEpoch() : BigInt(stored.epoch)
  const creditedEpoch = submittedEvent?.epoch ?? fallbackEpoch
  context.storage.updateDirectAudit(auditId, 'attested', {
    epoch: creditedEpoch.toString(),
    attestationTxHash,
    credited,
    failureReason: null,
  })

  if (evidenceUri) {
    try {
      await context.registryClient.publishEvidence(context.signer, auditId, evidenceUri)
      context.storage.updateDirectAudit(auditId, 'attested', { evidenceUri })
    } catch (error) {
      context.warn?.(`evidence publication failed for ${auditId}: ${asError(error).message}`)
    }
  }

  return {
    runId: auditId,
    auditId,
    evidencePath: stored.evidencePath,
    evidenceHash: stored.evidenceHash,
    attestationTxHash,
    credited,
    epoch: creditedEpoch,
    verdict,
    modelShareBps,
    probeCount: evidence.result.selectedProbeCount,
    authenticatedProbeCount: evidence.result.authenticatedProbeCount,
    parsedProbeCount: evidence.result.parsedProbeCount,
    exchanges: evidence.exchanges,
  }
}

function assertTrafficShareSnapshot(
  snapshot: TrafficShareSnapshot,
  sellerAddress: string,
  targetServiceHash: string,
  epochWindow: { epoch: bigint; startedAt: number; endsAt: number },
): void {
  if (snapshot.source.trim().length === 0) throw new Error('traffic-share source is missing')
  if (
    snapshot.epoch !== epochWindow.epoch
    || snapshot.windowStartedAt !== epochWindow.startedAt
    || snapshot.windowEndedAt !== epochWindow.endsAt
  ) {
    throw new Error('traffic-share snapshot does not match the requested epoch')
  }
  if (snapshot.sellerAddress.toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error('traffic-share snapshot seller mismatch')
  }
  if (snapshot.serviceHash.toLowerCase() !== targetServiceHash.toLowerCase()) {
    throw new Error('traffic-share snapshot service mismatch')
  }
  if (!Number.isSafeInteger(snapshot.indexedBlock) || snapshot.indexedBlock < 0) {
    throw new Error('traffic-share snapshot has an invalid indexed block')
  }
  const expectedShare = calculateTrafficShareBps(snapshot.serviceVolumeUsdc, snapshot.sellerVolumeUsdc)
  if (snapshot.modelShareBps !== expectedShare) throw new Error('traffic-share snapshot basis points are inconsistent')
}

export async function runDirectAudit(
  context: DirectAuditContext,
  input: RunDirectAuditInput,
): Promise<DirectAuditResult> {
  const observed = await executeDirectAuditObservation(context, input)
  const attested = await attestCompletedDirectAudit(context, observed.auditId, input.evidenceUri)
  return { ...attested, runId: observed.runId }
}

async function executeProbeBatches(
  context: DirectAuditExecutionContext,
  input: RunDirectAuditInput,
): Promise<BatchExecution[]> {
  const batches = chunk(input.reference.probes, KBF_PROBES_PER_REQUEST).map((probes, batchIndex) => ({
    batchIndex,
    ordinalStart: batchIndex * KBF_PROBES_PER_REQUEST,
    probes,
  }))
  return runConcurrently(batches, context.maxConcurrentProbeRequests, async (batch) => {
    return executeProbeBatch(context, input, batch)
  })
}

async function executeProbeBatch(
  context: DirectAuditExecutionContext,
  input: RunDirectAuditInput,
  batch: { batchIndex: number; ordinalStart: number; probes: KbfProbe[] },
): Promise<BatchExecution> {
  const existing = context.storage.listDirectAuditExchanges(input.runId)
    .find((exchange) => exchange.batchIndex === batch.batchIndex)
  if (existing?.state === 'succeeded' && existing.exchange) {
    const exchange = existing.exchange as unknown as DirectAuditEvidenceExchange
    const expectedProbeIds = batch.probes.map((probe) => probe.id)
    if (JSON.stringify(exchange.probeIds) !== JSON.stringify(expectedProbeIds)) {
      throw new Error(`stored exchange ${input.runId}:${batch.batchIndex} has different probes`)
    }
    return {
      batchIndex: batch.batchIndex,
      ordinalStart: batch.ordinalStart,
      probes: batch.probes,
      exchange,
      authenticated: Boolean(exchange.response && exchange.responseAuth && exchange.payment && exchange.response.statusCode === 200),
    }
  }

  const requestId = randomUUID()
  const requestBody = new TextEncoder().encode(JSON.stringify(
    buildDirectAuditRequestBody(input.reference, input.service, batch.probes),
  ))
  const request = {
    requestId,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: requestBody,
  }
  const requestHash = hashRequest(request)
  const startedAt = (context.now ?? Date.now)()
  context.storage.saveDirectAuditExchange({
    auditId: input.runId,
    batchIndex: batch.batchIndex,
    state: 'running',
    requestId,
    exchange: null,
    sellerChargeUsdc: '0',
    startedAt,
    completedAt: null,
    failureReason: null,
  })
  for (let offset = 0; offset < batch.probes.length; offset += 1) {
    const ordinal = batch.ordinalStart + offset
    context.storage.markDirectAuditProbeExposure(input.runId, ordinal, startedAt)
    context.storage.saveDirectAuditProbe({
      ...context.storage.listDirectAuditProbes(input.runId)[ordinal]!,
      requestId,
      requestHash,
      timing: { startedAt },
    })
  }

  let response: Awaited<ReturnType<DirectAuditNode['sendRequest']>> | null = null
  let responseAuth: StoredResponseAuth | null = null
  let payment: BuyerResponsePaymentEvidence | null = null
  let budgetTicket: number | null = null
  let budgetCommitted = false
  let failureReason: string | null = null
  let answers: Array<number | null> = new Array(batch.probes.length).fill(null)
  let matches: MatchVector = new Array(batch.probes.length).fill(null)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), context.probeRequestTimeoutMs)
  try {
    if (context.budget) {
      if (context.maxPerRequestUsdc === undefined) {
        throw new Error('maxPerRequestUsdc is required when a direct-audit budget is configured')
      }
      budgetTicket = context.budget.reserve(context.maxPerRequestUsdc)
    }
    response = await context.node.sendRequest(input.target, request, { signal: controller.signal })
    const remaining = Math.max(1, startedAt + context.probeRequestTimeoutMs - (context.now ?? Date.now)())
    responseAuth = await context.node.waitForResponseAuth(requestId, remaining)
    if (!responseAuth.verified) throw new Error(`ResponseAuth verification failed: ${responseAuth.verificationError ?? 'unknown'}`)
    if (responseAuth.requestHash.toLowerCase() !== requestHash.toLowerCase()) {
      throw new Error('ResponseAuth request hash mismatch')
    }
    const expectedResponseHash = hashResponse(response)
    if (responseAuth.responseHash.toLowerCase() !== expectedResponseHash.toLowerCase()) {
      throw new Error('ResponseAuth response hash mismatch')
    }
    payment = await context.node.finalizeResponsePayment(input.target, requestId)
    if (context.budget && budgetTicket !== null) {
      const totalSpent = context.budget.commit(budgetTicket, payment.sellerChargeUsdc)
      budgetCommitted = true
      context.onSpend?.(totalSpent)
    }
    if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`)
    const completion = extractCompletionText(response.body)
    if (completion === null) {
      failureReason = 'malformed completion response'
    } else {
      answers = parseKbfAnswers(completion, batch.probes.length)
      matches = computeMatchVector(answers, batch.probes)
      if (answers.every((answer) => answer === null)) failureReason = 'completion contained no parseable answers'
    }
  } catch (error) {
    failureReason = controller.signal.aborted
      ? `request timed out after ${context.probeRequestTimeoutMs}ms`
      : asError(error).message
  } finally {
    clearTimeout(timer)
    if (context.budget && budgetTicket !== null && !budgetCommitted) {
      context.budget.release(budgetTicket)
    }
  }

  const completedAt = (context.now ?? Date.now)()
  const responseLatencyMs = Math.max(0, completedAt - startedAt)
  const outputTokens = response ? parseOutputTokens(response.body) : 0
  const outputTokensPerSecondMilli = responseLatencyMs > 0
    ? clampUint32(Math.round((outputTokens * 1_000_000) / responseLatencyMs))
    : 0
  const authenticated = Boolean(response && responseAuth?.verified && payment && response.statusCode === 200)
  const exchange: DirectAuditEvidenceExchange = {
    requestId,
    probeIds: batch.probes.map((probe) => probe.id),
    request: {
      method: request.method,
      path: request.path,
      headers: request.headers,
      bodyBase64: Buffer.from(request.body).toString('base64'),
      hash: requestHash,
    },
    response: response ? {
      statusCode: response.statusCode,
      headers: response.headers,
      bodyBase64: Buffer.from(response.body).toString('base64'),
      hash: hashResponse(response),
    } : null,
    responseAuth: responseAuth ? toResponseAuthPayload(responseAuth) : null,
    payment: payment ? {
      sellerChargeUsdc: payment.sellerChargeUsdc.toString(),
      spendingAuth: payment.spendingAuth as unknown as Record<string, unknown>,
    } : null,
    timing: {
      startedAt,
      completedAt,
      responseLatencyMs,
      outputTokens,
      outputTokensPerSecondMilli,
    },
    answers,
    matches,
    status: authenticated && failureReason === null ? 'succeeded' : 'failed',
    failureReason,
  }
  context.storage.saveDirectAuditExchange({
    auditId: input.runId,
    batchIndex: batch.batchIndex,
    state: authenticated ? 'succeeded' : 'failed',
    requestId,
    exchange: exchange as unknown as Record<string, unknown>,
    sellerChargeUsdc: payment?.sellerChargeUsdc.toString() ?? '0',
    startedAt,
    completedAt,
    failureReason,
  })

  const persisted = context.storage.listDirectAuditProbes(input.runId)
  for (let offset = 0; offset < batch.probes.length; offset += 1) {
    const ordinal = batch.ordinalStart + offset
    const existing = persisted[ordinal]
    if (!existing) throw new Error(`direct audit probe ${ordinal} is missing`)
    context.storage.saveDirectAuditProbe({
      ...existing,
      status: exchange.status,
      requestId,
      requestHash,
      responseHash: exchange.response?.hash ?? null,
      responseAuth: exchange.responseAuth as unknown as Record<string, unknown> | null,
      payment: exchange.payment,
      timing: exchange.timing,
      matched: matches[offset] === null ? null : matches[offset] === 1,
      failureReason,
    })
  }
  return { ...batch, exchange, authenticated }
}

function buildMetricSnapshot(
  exchanges: readonly DirectAuditEvidenceExchange[],
  startedAtMs: number,
  completedAtMs: number,
): MetricSnapshot {
  const successful = exchanges.filter((exchange) => exchange.responseAuth !== null && exchange.payment !== null)
  const latencies = successful.map((exchange) => exchange.timing.responseLatencyMs)
  const throughputs = successful.map((exchange) => exchange.timing.outputTokensPerSecondMilli)
  return {
    windowStartedAt: Math.floor(startedAtMs / 1_000),
    windowEndedAt: Math.floor(completedAtMs / 1_000),
    eligibleAttempts: clampUint16(exchanges.length),
    successfulAttempts: clampUint16(successful.length),
    p50TtftMs: clampUint32(percentile(latencies, 0.5)),
    p95TtftMs: clampUint32(percentile(latencies, 0.95)),
    p50OutputTokensPerSecondMilli: clampUint32(percentile(throughputs, 0.5)),
    schemaVersion: 1,
    observationsRoot: canonicalHashBytes32(exchanges.map((exchange) => ({
      requestId: exchange.requestId,
      requestHash: exchange.request.hash,
      responseHash: exchange.response?.hash ?? null,
      responseStartedAt: exchange.responseAuth?.responseStartedAt ?? null,
      responseCompletedAt: exchange.responseAuth?.responseCompletedAt ?? null,
      sellerChargeUsdc: exchange.payment?.sellerChargeUsdc ?? null,
      timing: exchange.timing,
    }))),
  }
}

async function resolveSubmittedEvent(
  context: DirectAuditAttestationContext,
  input: { txHash: string; auditId: string; agentId: number; serviceHash: string },
): Promise<Pick<AttestationSubmittedEvent, 'credited' | 'epoch'> | null> {
  if (context.resolveSubmittedEvent) return context.resolveSubmittedEvent(input)
  const receipt = await context.registryClient.provider.getTransactionReceipt(input.txHash)
  if (!receipt) return null
  const events = await context.registryClient.queryAttestations(
    input.agentId,
    receipt.blockNumber,
    receipt.blockNumber,
  )
  return events.find((event) =>
    event.auditId.toLowerCase() === input.auditId.toLowerCase()
    && event.serviceHash.toLowerCase() === input.serviceHash.toLowerCase()
  ) ?? null
}

function verdictCode(verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'): Exclude<VerifierVerdict, 0> {
  if (verdict === 'SAME') return VERIFIER_VERDICT_SAME
  if (verdict === 'DIFF') return VERIFIER_VERDICT_DIFF
  return VERIFIER_VERDICT_UNDETERMINED
}

export function extractCompletionText(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
      content?: Array<{ type?: string; text?: unknown }>
      output_text?: unknown
    }
    const chatContent = parsed.choices?.[0]?.message?.content
    if (typeof chatContent === 'string') return chatContent
    const text = parsed.choices?.[0]?.text
    if (typeof text === 'string') return text
    const anthropicText = parsed.content?.find((block) => block?.type === 'text')?.text
    if (typeof anthropicText === 'string') return anthropicText
    return typeof parsed.output_text === 'string' ? parsed.output_text : null
  } catch {
    return null
  }
}

function parseOutputTokens(body: Uint8Array): number {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      usage?: { completion_tokens?: unknown; output_tokens?: unknown }
    }
    const value = parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

async function runConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0
}

function clampUint16(value: number): number {
  return Math.max(0, Math.min(65_535, Math.round(value)))
}

function clampUint32(value: number): number {
  return Math.max(0, Math.min(4_294_967_295, Math.round(value)))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
