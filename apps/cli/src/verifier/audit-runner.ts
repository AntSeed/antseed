import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AbstractSigner } from 'ethers'
import {
  assertMatchingQueryProfile,
  buildKbfChatRequestBody,
  canonicalHash,
  canonicalHashBytes32,
  KBF_PROBES_PER_REQUEST,
  type KbfReferenceV1,
  type ReferenceQueryProfileV1,
} from '@antseed/fingerprints'
import type {
  AuditRelayJobPayload,
  ConnectedRelay,
  PeerInfo,
  StoredAuditJob,
  StoredAuditPlan,
  VerificationAuditStore,
} from '@antseed/node'
import {
  buildPositionalMerkleTree,
  encodeHttpRequest,
  estimateFrozenRelayPayout,
  hashRequest,
  peerIdToAddress,
  preflightRelayBudget,
} from '@antseed/node'
import type {
  AuditJob,
  RelayAssignment,
  RelayTreasuryClient,
  VerifierRegistryClient,
} from '@antseed/node/payments'
import { computeCostUsdc, estimateTokensFromBytes } from '@antseed/node/payments'
import { assertAuditDurationMs, DEFAULT_AUDIT_DURATION_MS } from './audit-duration.js'
import { requireCommittedAuditPlan } from './audit-state.js'

export const AUDIT_COMMIT_BUFFER_SECS = 2 * 60
export const AUDIT_SAFETY_MARGIN_SECS = 10 * 60
export const FORCE_CLAIM_DELAY_SECS = 6 * 60 * 60
export const FORCE_CLAIM_WINDOW_SECS = 30 * 24 * 60 * 60

export interface AuditContext {
  registryClient: VerifierRegistryClient
  treasuryClient: RelayTreasuryClient
  storage: VerificationAuditStore
  signer: AbstractSigner
  chainId: string
  registryAddress: string
  treasuryAddress: string
  runRelayJob: (
    relayPeerId: string,
    offer: Omit<AuditRelayJobPayload, 'version'>,
    timeoutMs: number,
  ) => Promise<{
    status: 'ok' | 'error'
    error?: string
    responseBytesBase64?: string
    responseAuthPayloadBase64?: string
    sellerChargeUsdc?: string
    paymentMetadata?: Record<string, unknown>
  }>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface PlanReferenceAuditInput {
  auditId?: string
  source?: 'manual' | 'automatic'
  target: PeerInfo
  service: string
  reference: KbfReferenceV1
  executionProfile: ReferenceQueryProfileV1
  flatRelayFeeUsdc: bigint
  jobTimeoutMs: number
  durationMs?: number
  commitBufferSecs?: number
  safetyMarginSecs?: number
}

export interface PlannedReferenceAudit {
  plan: StoredAuditPlan
  jobs: StoredAuditJob[]
  jobTimeoutMs: number
}

export interface DispatchedReferenceAudit extends PlannedReferenceAudit {
  succeededJobs: number
  failedJobs: number
}

export async function planReferenceAudit(
  context: AuditContext,
  input: PlanReferenceAuditInput,
): Promise<PlannedReferenceAudit> {
  assertMatchingQueryProfile(input.reference.queryProfile, input.executionProfile)
  if (!input.target.onChainAgentId) throw new Error('target has no on-chain agent id')
  if (!peerAdvertisesService(input.target, input.service)) throw new Error(`target does not advertise service ${input.service}`)
  if (input.reference.probes.length % KBF_PROBES_PER_REQUEST !== 0) {
    throw new Error('reference probe count must divide into exact ten-probe jobs')
  }
  const jobCount = input.reference.probes.length / KBF_PROBES_PER_REQUEST
  if (!Number.isInteger(jobCount) || jobCount < 1 || jobCount > 50) throw new Error('audit job count must be from 1 through 50')
  if (!Number.isInteger(input.jobTimeoutMs) || input.jobTimeoutMs <= 0) throw new Error('jobTimeoutMs must be positive')
  const durationMs = assertAuditDurationMs(input.durationMs ?? DEFAULT_AUDIT_DURATION_MS)
  if (durationMs < input.jobTimeoutMs) throw new Error('audit duration must cover at least one job timeout')

  const nowMs = context.now?.() ?? Date.now()
  const nowSecs = Math.floor(nowMs / 1_000)
  const commitBufferSecs = input.commitBufferSecs ?? AUDIT_COMMIT_BUFFER_SECS
  const safetyMarginSecs = input.safetyMarginSecs ?? AUDIT_SAFETY_MARGIN_SECS
  const epochWindow = await context.registryClient.currentEpochWindow()
  const executeAfter = nowSecs + commitBufferSecs
  const schedulingEndSecs = executeAfter + Math.ceil(durationMs / 1_000)
  if (schedulingEndSecs + safetyMarginSecs > epochWindow.endsAt) {
    throw new Error(`insufficient epoch time for ${durationMs}ms audit duration`)
  }
  const executeBefore = epochWindow.endsAt
  const requiredRelayCount = await context.registryClient.requiredRelayCount(jobCount)
  const auditId = input.auditId ?? randomBytes32()
  const targetServiceHash = await context.registryClient.hashNormalizedService(input.service)
  const targetSalt = randomBytes32()
  const targetCommitment = await context.registryClient.hashAuditTarget(input.target.onChainAgentId, targetServiceHash, targetSalt)
  const forceClaimAvailableAt = executeBefore + FORCE_CLAIM_DELAY_SECS
  const forceClaimDeadline = forceClaimAvailableAt + FORCE_CLAIM_WINDOW_SECS

  const requestBytes = input.reference.probes.reduce<Uint8Array[]>((requests, _probe, index) => {
    if (index % KBF_PROBES_PER_REQUEST !== 0) return requests
    const probes = input.reference.probes.slice(index, index + KBF_PROBES_PER_REQUEST)
    const body = buildKbfChatRequestBody(input.service, probes, {
      batchIndexOffset: index,
      maxTokens: input.executionProfile.maxTokensPerRequest,
    })
    Object.assign(body, input.executionProfile.requestOverrides ?? {})
    requests.push(encodeHttpRequest({
      requestId: randomUUID(),
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    }))
    return requests
  }, [])
  const sellerQuotes = requestBytes.map((bytes) => estimateWorstCaseSellerQuote(input.target, input.service, bytes))
  const payoutPerJobUsdc = estimateFrozenRelayPayout(sellerQuotes, input.flatRelayFeeUsdc)
  const { requiredBudgetUsdc } = await preflightRelayBudget({
    treasury: context.treasuryClient,
    epoch: epochWindow.epoch,
    jobCount,
    payoutPerJobUsdc,
  })

  const jobWindowSecs = Math.max(1, Math.ceil(input.jobTimeoutMs / 1_000))
  const jobsWithoutProof = requestBytes.map((bytes, jobIndex): AuditJob => {
    const scheduledAt = deterministicScheduledAt(auditId, jobIndex, executeAfter * 1_000, durationMs, input.jobTimeoutMs)
    const jobExecuteAfter = Math.floor(scheduledAt / 1_000)
    return {
      auditId,
      jobIndex,
      sellerPeerId: peerIdToAddress(input.target.peerId),
      serviceHash: targetServiceHash,
      requestHash: hashRequest(decodeRequest(bytes)),
      jobSalt: randomBytes32(),
      executeAfter: jobExecuteAfter,
      executeBefore: Math.min(jobExecuteAfter + jobWindowSecs, executeBefore - safetyMarginSecs),
    }
  })
  const leaves = await Promise.all(jobsWithoutProof.map((job) => context.registryClient.hashAuditJob(job)))
  const tree = buildPositionalMerkleTree(leaves)
  const probeRoot = canonicalHashBytes32(input.reference.probes)
  const queryHash = canonicalHash(input.executionProfile)
  const verifierConfigHash = canonicalHashBytes32({
    version: 2,
    queryProfileHash: queryHash,
    jobTimeoutMs: input.jobTimeoutMs,
    durationMs,
    commitBufferSecs,
    safetyMarginSecs,
    flatRelayFeeUsdc: input.flatRelayFeeUsdc.toString(),
    requiredRelayCount,
  })
  const verifierAddress = await context.signer.getAddress()
  const createdAt = nowMs
  const jobs: StoredAuditJob[] = jobsWithoutProof.map((job, jobIndex) => ({
    auditId,
    jobIndex,
    state: 'planned',
    scheduledAt: job.executeAfter * 1_000,
    relayPeerId: null,
    relayBuyerAddress: null,
    assignmentAttempt: 0,
    assignmentSignature: null,
    assignmentState: 'unassigned',
    assignedAt: null,
    lastDispatchAt: null,
    sellerPeerId: input.target.peerId,
    service: input.service,
    serviceHash: targetServiceHash,
    requestHash: job.requestHash,
    jobSalt: job.jobSalt,
    executeAfter: job.executeAfter,
    executeBefore: job.executeBefore,
    requestBytes: requestBytes[jobIndex]!,
    positionalProof: tree.proofs[jobIndex]!,
    responseBytes: null,
    responseAuthPayload: null,
    sellerChargeUsdc: null,
    paymentMetadata: null,
    dispatchedAt: null,
    completedAt: null,
    failureKind: null,
    failureMessage: null,
    entitlementPersistedAt: null,
  }))
  const plan: StoredAuditPlan = {
    auditId,
    state: 'planned',
    source: input.source ?? 'manual',
    epoch: epochWindow.epoch.toString(),
    durationMs,
    chainId: context.chainId,
    registryAddress: context.registryAddress,
    treasuryAddress: context.treasuryAddress,
    verifierAddress,
    agentId: String(input.target.onChainAgentId),
    targetPeerId: input.target.peerId,
    targetService: input.service,
    targetServiceHash,
    targetSalt,
    targetCommitment,
    probeRoot,
    auditJobRoot: tree.root,
    referenceId: input.reference.referenceId,
    queryProfileHash: queryHash,
    verifierConfigHash,
    probeCount: input.reference.probes.length,
    jobCount,
    requiredRelayCount,
    jobTimeoutMs: input.jobTimeoutMs,
    payoutPerJobUsdc,
    reservedBudgetUsdc: requiredBudgetUsdc,
    commitTxHash: null,
    attestationTxHash: null,
    evidenceHash: null,
    evidenceUri: null,
    evidenceState: 'none',
    executeAfter,
    executeBefore,
    forceClaimAvailableAt,
    forceClaimDeadline,
    createdAt,
    updatedAt: createdAt,
    failureReason: null,
  }
  context.storage.saveAuditPlan(plan, jobs, { replaceJobs: true })
  return { plan, jobs, jobTimeoutMs: input.jobTimeoutMs }
}

export async function planAndCommitReferenceAudit(
  context: AuditContext,
  input: PlanReferenceAuditInput,
): Promise<PlannedReferenceAudit> {
  const planned = await planReferenceAudit(context, input)
  const committed = await resumeReferenceAuditCommit(context, planned.plan)
  return { ...planned, plan: committed }
}

export async function dispatchDueReferenceAuditJobs(
  context: AuditContext,
  plan: StoredAuditPlan,
  connectedRelays: readonly ConnectedRelay[],
): Promise<DispatchedReferenceAudit> {
  if (plan.payoutPerJobUsdc === null || plan.chainId === null || plan.registryAddress === null || plan.treasuryAddress === null) {
    throw new Error('audit plan is not committed')
  }
  const audit = await context.registryClient.getAudit(plan.auditId)
  const now = context.now?.() ?? Date.now()
  const allJobs = context.storage.listAuditJobs(plan.auditId)
  const dueJobs = allJobs.filter((job) => ['planned', 'due', 'assigned'].includes(job.state) && job.scheduledAt <= now)
  if (dueJobs.length > 0) context.storage.updateAuditState(plan.auditId, 'executing')
  for (const storedJob of dueJobs) {
    let job = storedJob
    let relay = job.relayPeerId ? connectedRelays.find((candidate) => candidate.peerId === job.relayPeerId) : undefined
    if (!relay) {
      if (job.assignmentSignature) continue
      relay = selectRelayForJob(
        allJobs,
        connectedRelays,
        plan.payoutPerJobUsdc,
        plan.requiredRelayCount ?? 1,
      ) ?? undefined
      if (!relay) continue
      const assignment = buildRelayAssignment(plan, job, relay)
      const assignmentSignature = await context.registryClient.signRelayAssignment(context.signer, assignment)
      context.storage.assignAuditJob({
        auditId: job.auditId,
        jobIndex: job.jobIndex,
        relayPeerId: relay.peerId,
        relayBuyerAddress: assignment.relayBuyer,
        assignmentAttempt: assignment.attempt,
        assignmentSignature,
      })
      job = context.storage.listAuditJobs(plan.auditId).find((candidate) => candidate.jobIndex === job.jobIndex)!
      const jobPosition = allJobs.findIndex((candidate) => candidate.jobIndex === job.jobIndex)
      if (jobPosition >= 0) allJobs[jobPosition] = job
    }
    const offer = buildRelayOffer(plan, audit, job, plan.jobTimeoutMs)
    context.storage.markAuditJobDispatchAttempt(job.auditId, job.jobIndex, now)
    // Count conservatively before handing the private prompt to a relay. The
    // seller may receive it even when the relay later times out or returns an
    // ambiguous execution error. Storage makes this idempotent across retries.
    context.storage.markAuditJobProbeExposure(job.auditId, job.jobIndex, now)
    try {
      const result = await context.runRelayJob(relay.peerId, offer, offer.timeoutMs)
      if (result.status !== 'ok') {
        if (isExplicitPreExecutionRejection(result.error ?? '')) {
          context.storage.markAuditJobRejected(job.auditId, job.jobIndex, result.error ?? 'relay rejected job')
        } else {
          context.storage.markAuditJobDispatched(job.auditId, job.jobIndex, now)
          context.storage.markAuditJobFailed(
            job.auditId,
            job.jobIndex,
            'relay-execution',
            result.error ?? 'relay execution failed',
            now,
          )
        }
        continue
      }
      if (!result.responseBytesBase64 || !result.responseAuthPayloadBase64
        || result.sellerChargeUsdc === undefined || !result.paymentMetadata) {
        context.storage.markAuditJobDispatched(job.auditId, job.jobIndex, now)
        context.storage.markAuditJobFailed(job.auditId, job.jobIndex, 'invalid-relay-result', 'relay result is incomplete', now)
        continue
      }
      context.storage.markAuditJobDispatched(job.auditId, job.jobIndex, now)
      context.storage.persistAuditJobSuccess({
        auditId: job.auditId,
        jobIndex: job.jobIndex,
        responseBytes: Buffer.from(result.responseBytesBase64, 'base64'),
        responseAuthPayload: Buffer.from(result.responseAuthPayloadBase64, 'base64'),
        sellerChargeUsdc: BigInt(result.sellerChargeUsdc),
        paymentMetadata: result.paymentMetadata,
      })
    } catch {}
  }
  const refreshedJobs = context.storage.listAuditJobs(plan.auditId)
  const succeededJobs = refreshedJobs.filter((job) => job.state === 'succeeded').length
  const failedJobs = refreshedJobs.filter((job) => job.state === 'failed').length
  if (plan.executeBefore !== null && Math.floor(now / 1_000) >= plan.executeBefore) {
    for (const job of refreshedJobs.filter((candidate) => !['succeeded', 'failed'].includes(candidate.state))) {
      context.storage.markAuditJobFailed(job.auditId, job.jobIndex, 'execution-window-expired', 'audit execution window expired')
    }
    context.storage.updateAuditState(plan.auditId, 'awaiting-attestation')
  }
  return { plan, jobs: context.storage.listAuditJobs(plan.auditId), jobTimeoutMs: plan.jobTimeoutMs, succeededJobs, failedJobs }
}

export async function resumeReferenceAuditCommit(
  context: AuditContext,
  storedPlan: StoredAuditPlan,
): Promise<StoredAuditPlan> {
  const plan = requireCommittedAuditPlan(storedPlan)
  const existing = await context.registryClient.getAudit(plan.auditId)
  if (!isZeroAddress(existing.committer)) {
    assertPersistedCommitMatches(plan, existing)
    context.storage.updateAuditState(plan.auditId, 'committed', {
      ...(plan.commitTxHash ? { commitTxHash: plan.commitTxHash } : {}),
    })
    return { ...plan, state: 'committed', failureReason: null }
  }

  context.storage.updateAuditState(plan.auditId, 'committing')
  try {
    const commitTxHash = await context.registryClient.commitProbes(context.signer, {
      auditId: plan.auditId,
      targetCommitment: plan.targetCommitment,
      probeRoot: plan.probeRoot,
      auditJobRoot: plan.auditJobRoot,
      referenceId: contentIdToBytes32(plan.referenceId),
      verifierConfigHash: plan.verifierConfigHash,
      probeCount: plan.probeCount,
      jobCount: plan.jobCount,
      payoutPerJobUsdc: plan.payoutPerJobUsdc,
    })
    const committed = await context.registryClient.getAudit(plan.auditId)
    assertPersistedCommitMatches(plan, committed)
    context.storage.updateAuditState(plan.auditId, 'committed', { commitTxHash })
    return { ...plan, state: 'committed', commitTxHash, failureReason: null }
  } catch (error) {
    const committed = await context.registryClient.getAudit(plan.auditId).catch(() => null)
    if (committed && !isZeroAddress(committed.committer)) {
      assertPersistedCommitMatches(plan, committed)
      context.storage.updateAuditState(plan.auditId, 'committed')
      return { ...plan, state: 'committed', failureReason: null }
    }
    context.storage.updateAuditState(plan.auditId, 'committing', { failureReason: (error as Error).message })
    throw error
  }
}

export async function dispatchReferenceAudit(
  context: AuditContext,
  planned: PlannedReferenceAudit,
  connectedRelays: readonly ConnectedRelay[],
): Promise<DispatchedReferenceAudit> {
  const sleep = context.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let result = await dispatchDueReferenceAuditJobs(context, planned.plan, connectedRelays)
  while (result.jobs.some((job) => !['succeeded', 'failed'].includes(job.state))) {
    await sleep(1_000)
    result = await dispatchDueReferenceAuditJobs(context, planned.plan, connectedRelays)
  }
  return result
}

export async function runReferenceAudit(
  context: AuditContext,
  input: PlanReferenceAuditInput,
  connectedRelays: readonly ConnectedRelay[],
): Promise<DispatchedReferenceAudit> {
  const planned = await planAndCommitReferenceAudit(context, input)
  return dispatchReferenceAudit(context, planned, connectedRelays)
}

export function buildRelayOffer(
  plan: StoredAuditPlan,
  audit: Awaited<ReturnType<VerifierRegistryClient['getAudit']>>,
  job: StoredAuditJob,
  jobTimeoutMs: number,
): Omit<AuditRelayJobPayload, 'version'> {
  if (!plan.chainId || !plan.registryAddress || !plan.treasuryAddress || plan.payoutPerJobUsdc === null
    || !job.relayBuyerAddress || !job.assignmentSignature) throw new Error('audit job has no relay assignment')
  const assignment = buildRelayAssignment(plan, job, { peerId: job.relayPeerId! } as ConnectedRelay)
  return {
    jobId: `${job.auditId}:${job.jobIndex}`,
    chainId: plan.chainId,
    registryAddress: plan.registryAddress,
    treasuryAddress: plan.treasuryAddress,
    auditSnapshot: {
      committer: audit.committer,
      auditJobRoot: audit.auditJobRoot,
      jobCount: audit.jobCount,
      payoutPerJobUsdc: audit.payoutPerJobUsdc.toString(),
      reservedRelayBudgetUsdc: audit.reservedRelayBudgetUsdc.toString(),
      executeAfter: audit.executeAfter,
      executeBefore: audit.executeBefore,
      forceClaimAvailableAt: audit.forceClaimAvailableAt,
      forceClaimDeadline: audit.forceClaimDeadline,
      attested: audit.attested,
    },
    job: {
      auditId: job.auditId,
      jobIndex: job.jobIndex,
      sellerPeerId: peerIdToAddress(job.sellerPeerId),
      serviceHash: job.serviceHash,
      requestHash: job.requestHash,
      jobSalt: job.jobSalt,
      executeAfter: job.executeAfter,
      executeBefore: job.executeBefore,
    },
    jobProof: job.positionalProof,
    assignment: { ...assignment, payoutPerJobUsdc: assignment.payoutPerJobUsdc.toString() },
    verifierSignature: job.assignmentSignature,
    targetPeerId: job.sellerPeerId,
    service: job.service,
    requestBytesBase64: Buffer.from(job.requestBytes).toString('base64'),
    payoutPerJobUsdc: plan.payoutPerJobUsdc.toString(),
    timeoutMs: Math.max(1, Math.min(jobTimeoutMs, (assignment.executeBefore - assignment.executeAfter) * 1_000)),
  }
}

export function buildRelayAssignment(plan: StoredAuditPlan, job: StoredAuditJob, relay: ConnectedRelay): RelayAssignment {
  if (plan.payoutPerJobUsdc === null) throw new Error('audit payout is unavailable')
  return {
    auditId: job.auditId,
    jobIndex: job.jobIndex,
    attempt: job.assignmentAttempt,
    relayBuyer: job.relayBuyerAddress ?? peerIdToAddress(relay.peerId),
    payoutPerJobUsdc: plan.payoutPerJobUsdc,
    executeAfter: job.executeAfter,
    executeBefore: job.executeBefore,
  }
}

export function deterministicScheduledAt(
  auditId: string,
  jobIndex: number,
  startMs: number,
  durationMs: number,
  jobTimeoutMs: number,
): number {
  const availableMs = Math.max(0, durationMs - jobTimeoutMs)
  if (availableMs === 0) return startMs
  const digest = createHash('sha256').update(`${auditId}:${jobIndex}`).digest()
  const offset = Number(digest.readBigUInt64BE(0) % BigInt(availableMs + 1))
  return startMs + offset
}

export function selectRelayForJob(
  auditJobs: readonly StoredAuditJob[],
  connectedRelays: readonly ConnectedRelay[],
  payoutPerJobUsdc: bigint,
  requiredRelayCount = 1,
): ConnectedRelay | null {
  const counts = new Map<string, number>()
  for (const job of auditJobs) if (job.relayPeerId) counts.set(job.relayPeerId, (counts.get(job.relayPeerId) ?? 0) + 1)
  const eligible = connectedRelays.filter((relay) => relay.minPayoutPerJobUsdc <= payoutPerJobUsdc)
  if (eligible.length < requiredRelayCount) return null
  return eligible
    .filter((relay) => relay.activeJobs < relay.maxConcurrentJobs)
    .sort((left, right) => {
      const usageDifference = (counts.get(left.peerId) ?? 0) - (counts.get(right.peerId) ?? 0)
      return usageDifference || left.peerId.localeCompare(right.peerId)
    })[0] ?? null
}

export function estimateWorstCaseSellerQuote(peer: PeerInfo, service: string, requestBytes: Uint8Array): bigint {
  const request = decodeRequest(requestBytes)
  const pricing = servicePricing(peer, service)
  const body = JSON.parse(new TextDecoder().decode(request.body)) as { max_tokens?: unknown; max_completion_tokens?: unknown }
  const maxOutputTokens = positiveInteger(body.max_tokens ?? body.max_completion_tokens)
  if (maxOutputTokens === null) throw new Error('audit request has no bounded output token count')
  return computeCostUsdc(estimateTokensFromBytes(request.body), maxOutputTokens, pricing)
}

export function shouldBackoffSeller(failureKind: string): boolean {
  return ['dispatch-timeout', 'seller-transport', 'invalid-response-auth', 'seller-http'].includes(failureKind)
}

function isExplicitPreExecutionRejection(message: string): boolean {
  return ['busy', 'rate_limited', 'relay_at_capacity', 'verifier_not_approved', 'relay payout below configured minimum']
    .some((value) => message.toLowerCase().includes(value))
}

function servicePricing(peer: PeerInfo, service: string): {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
} {
  const normalized = service.trim().toLowerCase()
  for (const entry of Object.values(peer.providerPricing ?? {})) {
    for (const [advertised, pricing] of Object.entries(entry.services ?? {})) {
      if (advertised.trim().toLowerCase() === normalized) return pricing
    }
  }
  if (peer.defaultInputUsdPerMillion === undefined || peer.defaultOutputUsdPerMillion === undefined) {
    throw new Error(`target has no pricing for ${service}`)
  }
  return {
    inputUsdPerMillion: peer.defaultInputUsdPerMillion,
    outputUsdPerMillion: peer.defaultOutputUsdPerMillion,
    ...(peer.defaultCachedInputUsdPerMillion !== undefined
      ? { cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion }
      : {}),
  }
}

function peerAdvertisesService(peer: PeerInfo, service: string): boolean {
  const normalized = service.trim().toLowerCase()
  for (const provider of peer.metadata?.providers ?? []) {
    if ((provider.services ?? []).some((candidate) => candidate.trim().toLowerCase() === normalized)) return true
  }
  return Object.values(peer.providerPricing ?? {}).some((entry) =>
    Object.keys(entry.services ?? {}).some((candidate) => candidate.trim().toLowerCase() === normalized),
  )
}

function decodeRequest(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const decoder = new TextDecoder()
  const requestIdLength = view.getUint16(offset); offset += 2
  const requestId = decoder.decode(bytes.subarray(offset, offset + requestIdLength)); offset += requestIdLength
  const methodLength = view.getUint8(offset); offset += 1
  const method = decoder.decode(bytes.subarray(offset, offset + methodLength)); offset += methodLength
  const pathLength = view.getUint16(offset); offset += 2
  const path = decoder.decode(bytes.subarray(offset, offset + pathLength)); offset += pathLength
  const headerCount = view.getUint16(offset); offset += 2
  const headers: Record<string, string> = {}
  for (let index = 0; index < headerCount; index += 1) {
    const keyLength = view.getUint16(offset); offset += 2
    const key = decoder.decode(bytes.subarray(offset, offset + keyLength)); offset += keyLength
    const valueLength = view.getUint16(offset); offset += 2
    const value = decoder.decode(bytes.subarray(offset, offset + valueLength)); offset += valueLength
    headers[key] = value
  }
  const bodyLength = view.getUint32(offset); offset += 4
  const body = bytes.subarray(offset, offset + bodyLength)
  if (offset + bodyLength !== bytes.length) throw new Error('invalid encoded audit request')
  return { requestId, method, path, headers, body }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function randomBytes32(): string {
  return `0x${randomBytes(32).toString('hex')}`
}

function contentIdToBytes32(contentId: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(contentId)) return contentId
  const match = /^sha256:([0-9a-fA-F]{64})$/.exec(contentId)
  if (!match) throw new Error(`content id is not bytes32-compatible: ${contentId}`)
  return `0x${match[1]}`
}

function isZeroAddress(value: string): boolean {
  return /^0x0{40}$/i.test(value)
}

function assertPersistedCommitMatches(
  plan: ReturnType<typeof requireCommittedAuditPlan>,
  committed: Awaited<ReturnType<VerifierRegistryClient['getAudit']>>,
): void {
  if (committed.auditJobRoot.toLowerCase() !== plan.auditJobRoot.toLowerCase()
    || committed.targetCommitment.toLowerCase() !== plan.targetCommitment.toLowerCase()
    || committed.probeRoot.toLowerCase() !== plan.probeRoot.toLowerCase()
    || committed.jobCount !== plan.jobCount
    || committed.probeCount !== plan.probeCount
    || committed.payoutPerJobUsdc !== plan.payoutPerJobUsdc) {
    throw new Error('on-chain audit does not match the persisted relay-neutral plan')
  }
}
