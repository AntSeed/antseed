import { join } from 'node:path'
import type { AbstractSigner } from 'ethers'
import {
  KbfVerifier,
  parseKbfAnswers,
  subsetReferenceSelfTest,
  type FingerprintVerdict,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type {
  StoredAuditJob,
  StoredAuditPlan,
  VerificationAuditStore,
} from '@antseed/node'
import {
  decodeContractResponseAuthPayload,
  decodeHttpRequest,
  decodeHttpResponse,
  extractContractResponseAuthSigningPayload,
  hashRequest,
  hashResponse,
  peerIdToAddress,
  verifyPositionalMerkleProof,
  verifyResponseAuth,
  verifyResponseAuthExecutionWindow,
} from '@antseed/node'
import type {
  AuditJob,
  MetricSnapshot,
  RelayAssignment,
  RelayClaim,
  RelayTreasuryClient,
  VerifierRegistryClient,
  VerifierVerdict,
} from '@antseed/node/payments'
import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
} from '@antseed/node/payments'
import {
  canonicalEvidenceHash,
  canonicalEvidenceBytes,
  createCanonicalAuditEvidenceV2,
  verifyCanonicalEvidenceFile,
  writeCanonicalEvidence,
  type CanonicalAuditEvidenceJobV2,
  type CanonicalAuditEvidenceV2,
} from './evidence-v2.js'
import {
  requireAssignedAuditJob,
  requireCommittedAuditPlan,
  type CommittedAuditPlan,
} from './audit-state.js'

export const ATTEST_NOT_READY_EXIT_CODE = 3

export interface AttestationRuntime {
  registryClient: VerifierRegistryClient
  treasuryClient: RelayTreasuryClient
  storage: VerificationAuditStore
  signer: AbstractSigner
  dataDir: string
  refreshUsageAttribution?: () => Promise<boolean>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface AttestReferenceAuditInput {
  auditId: string
  /** Exact selected subset used for requests and scoring. */
  reference: KbfReferenceV1
  /** Content-addressed full reference persisted in canonical evidence. */
  fullReference?: KbfReferenceV1
  wait?: boolean
}

export interface AttestedReferenceAudit {
  plan: StoredAuditPlan
  verdict: FingerprintVerdict
  evidence: CanonicalAuditEvidenceV2
  evidenceHash: string
  evidencePath: string
  attestationTxHash: string
  submittedClaims: number
  alreadyPaidClaims: number
}

export async function attestReferenceAudit(
  runtime: AttestationRuntime,
  input: AttestReferenceAuditInput,
): Promise<AttestedReferenceAudit> {
  const storedPlan = runtime.storage.getAuditPlan(input.auditId)
  if (!storedPlan) throw new Error(`unknown audit ${input.auditId}`)
  const plan = requireCommittedAuditPlan(storedPlan)
  if (plan.referenceId !== input.reference.referenceId) throw new Error('reference id does not match audit plan')
  const fullReference = input.fullReference ?? input.reference
  if (plan.referenceId !== fullReference.referenceId) throw new Error('full reference id does not match audit plan')
  if (plan.state === 'attested') throw new Error('audit is already attested')
  const chainAudit = await runtime.registryClient.getAudit(plan.auditId)
  if (chainAudit.attested) throw new Error('audit is already attested on chain')
  if (chainAudit.auditJobRoot.toLowerCase() !== plan.auditJobRoot.toLowerCase()) throw new Error('audit job root mismatch')
  if (chainAudit.targetCommitment.toLowerCase() !== plan.targetCommitment.toLowerCase()) throw new Error('audit target commitment mismatch')
  const nowSecs = Math.floor((runtime.now?.() ?? Date.now()) / 1_000)
  if (nowSecs < chainAudit.executeBefore) {
    if (input.wait === false) throw new AuditNotReadyError(chainAudit.executeBefore)
    const sleep = runtime.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
    await sleep((chainAudit.executeBefore - nowSecs) * 1_000)
  }
  const afterWaitSecs = Math.floor((runtime.now?.() ?? Date.now()) / 1_000)
  if (afterWaitSecs > chainAudit.forceClaimDeadline) throw new Error('audit attestation window expired')

  const jobs = runtime.storage.listAuditJobs(plan.auditId)
  if (jobs.length !== plan.jobCount) throw new Error('persisted audit job count mismatch')
  const paidBitmap = await runtime.registryClient.relayJobPaidBitmap(plan.auditId)
  const validated = await validateAuditJobs(runtime.registryClient, plan, jobs, paidBitmap)
  const answers = extractAuditAnswers(input.reference, validated.validJobs)
  const kbf = new KbfVerifier().verify(input.reference, {
    sellerPeerId: plan.targetPeerId,
    agentId: Number(plan.agentId),
    answers,
    requestIds: jobs.map((job) => decodeHttpRequest(job.requestBytes).requestId),
  })
  const verdict = normalizeAttestableVerdict(kbf.verdict)
  const validJobCount = validated.validJobs.length
  const distinctRelayCount = new Set(validated.validJobs.map(({ job }) => requireAssignedAuditJob(job).relayBuyerAddress.toLowerCase())).size
  if ((verdict === 'SAME' || verdict === 'DIFF') && validJobCount * 2 < plan.jobCount) {
    throw new Error('insufficient valid relay coverage for conclusive attestation')
  }
  if ((verdict === 'SAME' || verdict === 'DIFF') && distinctRelayCount < plan.requiredRelayCount) {
    throw new Error('insufficient relay diversity for conclusive attestation')
  }

  const reservation = await runtime.treasuryClient.getReservation(plan.auditId)
  if (reservation.released || reservation.releaseAfter < afterWaitSecs) throw new Error('relay reservation expired')
  const epochWindow = await runtime.registryClient.currentEpochWindow()
  const epochDuration = epochWindow.endsAt - epochWindow.startedAt
  const auditedEpochStartedAt = chainAudit.executeBefore - epochDuration
  const usageAttributionAvailable = await runtime.refreshUsageAttribution?.() ?? false
  const modelShareBps = verdict === 'DIFF'
    ? runtime.storage.computeModelShareBps(plan.agentId, plan.targetService, auditedEpochStartedAt * 1_000, chainAudit.executeBefore * 1_000)
    : 0
  const exactSubsetBaseline = subsetReferenceSelfTest(
    input.reference,
    input.reference.probes.map((probe) => probe.id),
  )
  const evidence = createCanonicalAuditEvidenceV2({
    plan,
    reference: fullReference,
    exactSubsetBaseline,
    jobs: validated.evidenceJobs,
    kbf,
    reservation,
    relayPaidBitmap: paidBitmap,
    modelShareBps,
    usageAttributionAvailable,
    epochStartedAt: auditedEpochStartedAt,
    epochEndedAt: chainAudit.executeBefore,
    verifierConfiguration: {
      queryProfileHash: plan.queryProfileHash,
      verifierConfigHash: plan.verifierConfigHash,
      evidenceSchemaVersion: 2,
      selectedProbeIds: input.reference.probes.map((probe) => probe.id),
    },
  })
  const evidenceHash = canonicalEvidenceHash(evidence)
  const evidencePath = join(runtime.dataDir, 'verifier', 'evidence', `${plan.auditId}.json`)
  await writeCanonicalEvidence(evidencePath, evidence)
  await verifyCanonicalEvidenceFile(evidencePath, evidenceHash)

  const metrics = buildMetricSnapshot(plan, validated.evidenceJobs)
  const claims = validated.validJobs.filter(({ paid }) => !paid).map(({ claim }) => claim)
  const submit = {
    auditId: plan.auditId,
    agentId: BigInt(plan.agentId),
    serviceHash: plan.targetServiceHash,
    targetSalt: plan.targetSalt,
    verdict: verdictCode(verdict),
    modelShareBps,
    metrics,
    evidenceHash,
    evidenceUri: '',
    relayClaims: claims,
  }
  runtime.storage.updateAuditState(plan.auditId, 'attesting')
  await runtime.registryClient.simulateSubmitAttestation(runtime.signer, submit)
  const attestationTxHash = await runtime.registryClient.submitAttestation(runtime.signer, submit)
  runtime.storage.updateAuditState(plan.auditId, 'attested', {
    attestationTxHash,
    evidenceHash,
    evidenceState: 'local',
  })
  return {
    plan: { ...plan, state: 'attested', attestationTxHash, evidenceHash, evidenceState: 'local' },
    verdict,
    evidence,
    evidenceHash,
    evidencePath,
    attestationTxHash,
    submittedClaims: claims.length,
    alreadyPaidClaims: validated.validJobs.filter(({ paid }) => paid).length,
  }
}

export async function publishEvidenceOnce(input: {
  runtime: AttestationRuntime
  auditId: string
  evidence: CanonicalAuditEvidenceV2
  upload: (bytes: Uint8Array) => Promise<string>
  download: (uri: string) => Promise<Uint8Array>
}): Promise<{ uri: string; txHash: string }> {
  const plan = input.runtime.storage.getAuditPlan(input.auditId)
  if (!plan?.evidenceHash) throw new Error('local evidence is not finalized')
  const chainAudit = await input.runtime.registryClient.getAudit(input.auditId)
  if (chainAudit.evidenceUri) throw new Error('evidence URI is already published')
  const bytes = canonicalEvidenceBytes(input.evidence)
  const uri = await input.upload(bytes)
  const downloaded = await input.download(uri)
  if (!Buffer.from(downloaded).equals(Buffer.from(bytes))) {
    throw new Error('published evidence bytes are not byte-identical to local canonical evidence')
  }
  const parsed = JSON.parse(new TextDecoder().decode(downloaded)) as CanonicalAuditEvidenceV2
  if (canonicalEvidenceHash(parsed).toLowerCase() !== plan.evidenceHash.toLowerCase()) {
    throw new Error('published evidence bytes do not match local evidence hash')
  }
  const txHash = await input.runtime.registryClient.publishEvidence(input.runtime.signer, input.auditId, uri)
  input.runtime.storage.updateAuditState(input.auditId, 'attested', {
    evidenceUri: uri,
    evidenceState: 'published',
  })
  return { uri, txHash }
}

export class AuditNotReadyError extends Error {
  readonly exitCode = ATTEST_NOT_READY_EXIT_CODE

  constructor(readonly readyAt: number) {
    super(`audit is not ready until ${new Date(readyAt * 1_000).toISOString()}`)
  }
}

async function validateAuditJobs(
  registryClient: VerifierRegistryClient,
  plan: CommittedAuditPlan,
  jobs: StoredAuditJob[],
  paidBitmap: bigint,
): Promise<{
  validJobs: Array<{ job: StoredAuditJob; claim: RelayClaim; paid: boolean }>
  evidenceJobs: CanonicalAuditEvidenceJobV2[]
}> {
  const indexes = new Set<number>()
  const requestHashes = new Set<string>()
  const validJobs: Array<{ job: StoredAuditJob; claim: RelayClaim; paid: boolean }> = []
  const evidenceJobs: CanonicalAuditEvidenceJobV2[] = []
  for (const stored of jobs) {
    if (indexes.has(stored.jobIndex)) throw new Error(`duplicate job index ${stored.jobIndex}`)
    indexes.add(stored.jobIndex)
    const normalizedRequestHash = stored.requestHash.toLowerCase()
    if (requestHashes.has(normalizedRequestHash)) throw new Error(`duplicate request hash ${stored.requestHash}`)
    requestHashes.add(normalizedRequestHash)
    const paid = (paidBitmap & (1n << BigInt(stored.jobIndex))) !== 0n
    let parsedResponseAuth = null
    if (stored.state === 'succeeded' && stored.responseBytes && stored.responseAuthPayload) {
      const request = decodeHttpRequest(stored.requestBytes)
      const response = decodeHttpResponse(stored.responseBytes)
      const auth = decodeContractResponseAuthPayload(stored.responseAuthPayload)
      const assignedJob = requireAssignedAuditJob(stored)
      const contractJob = toContractJob(assignedJob)
      const assignment = toRelayAssignment(plan, assignedJob)
      const leaf = await registryClient.hashAuditJob(contractJob)
      if (!verifyPositionalMerkleProof({
        root: plan.auditJobRoot,
        leaf,
        jobIndex: stored.jobIndex,
        jobCount: plan.jobCount,
        proof: stored.positionalProof,
      })) throw new Error(`invalid positional proof for job ${stored.jobIndex}`)
      const verification = verifyResponseAuth(auth, {
        request,
        response,
        buyerPeerId: assignedJob.relayBuyerAddress,
        sellerPeerId: stored.sellerPeerId,
        advertisedService: stored.service,
        ...(auth.channelId ? { channelId: auth.channelId } : {}),
      })
      if (!verification.valid || auth.statusCode !== 200) {
        throw new Error(`invalid ResponseAuth for job ${stored.jobIndex}: ${verification.reason ?? 'status'}`)
      }
      if (hashRequest(request).toLowerCase() !== stored.requestHash.toLowerCase()
        || hashResponse(response).toLowerCase() !== auth.responseHash.toLowerCase()) {
        throw new Error(`request/response hash mismatch for job ${stored.jobIndex}`)
      }
      parsedResponseAuth = await registryClient.parseResponseAuthPayload(
        hex(extractContractResponseAuthSigningPayload(stored.responseAuthPayload)),
      )
      if (parsedResponseAuth.buyer.toLowerCase() !== assignedJob.relayBuyerAddress.toLowerCase()) {
        throw new Error(`ResponseAuth buyer mismatch for job ${stored.jobIndex}`)
      }
      if (parsedResponseAuth.seller.toLowerCase() !== peerIdToAddress(stored.sellerPeerId).toLowerCase()) {
        throw new Error(`ResponseAuth seller mismatch for job ${stored.jobIndex}`)
      }
      if (parsedResponseAuth.advertisedServiceHash.toLowerCase() !== stored.serviceHash.toLowerCase()) {
        throw new Error(`ResponseAuth service mismatch for job ${stored.jobIndex}`)
      }
      if (parsedResponseAuth.requestHash.toLowerCase() !== stored.requestHash.toLowerCase()) {
        throw new Error(`ResponseAuth request mismatch for job ${stored.jobIndex}`)
      }
      if (parsedResponseAuth.statusCode !== 200 || /^0x0{64}$/i.test(parsedResponseAuth.responseHash)) {
        throw new Error(`ResponseAuth status or response hash is invalid for job ${stored.jobIndex}`)
      }
      const executionWindow = verifyResponseAuthExecutionWindow(
        parsedResponseAuth,
        stored.executeAfter,
        stored.executeBefore,
      )
      if (!executionWindow.valid) {
        throw new Error(`ResponseAuth execution window is invalid for job ${stored.jobIndex}: ${executionWindow.reason}`)
      }
      const paymentKey = await registryClient.paidRequestHash(stored.requestHash)
      if (paid && /^0x0{64}$/i.test(paymentKey)) throw new Error(`paid job ${stored.jobIndex} has no request payment key`)
      if (!paid && !/^0x0{64}$/i.test(paymentKey)) throw new Error(`request ${stored.requestHash} was paid by another job`)
      validJobs.push({
        job: stored,
        paid,
        claim: {
          job: contractJob,
          jobProof: stored.positionalProof,
          assignment,
          verifierSignature: assignedJob.assignmentSignature,
          responseAuthPayload: hex(stored.responseAuthPayload),
        },
      })
    }
    evidenceJobs.push({
      jobIndex: stored.jobIndex,
      state: stored.state,
      relayPeerId: stored.relayPeerId,
      relayBuyerAddress: stored.relayBuyerAddress,
      assignmentAttempt: stored.assignmentAttempt,
      assignmentSignature: stored.assignmentSignature,
      sellerPeerId: stored.sellerPeerId,
      service: stored.service,
      serviceHash: stored.serviceHash,
      requestHash: stored.requestHash,
      jobSalt: stored.jobSalt,
      executeAfter: stored.executeAfter,
      executeBefore: stored.executeBefore,
      positionalProof: stored.positionalProof,
      requestBytesBase64: Buffer.from(stored.requestBytes).toString('base64'),
      responseBytesBase64: stored.responseBytes ? Buffer.from(stored.responseBytes).toString('base64') : null,
      responseAuthPayloadBase64: stored.responseAuthPayload ? Buffer.from(stored.responseAuthPayload).toString('base64') : null,
      parsedResponseAuth,
      sellerChargeUsdc: stored.sellerChargeUsdc?.toString() ?? null,
      paymentMetadata: stored.paymentMetadata,
      failureKind: stored.failureKind,
      failureMessage: stored.failureMessage,
      relayPaid: paid,
    })
  }
  return { validJobs, evidenceJobs }
}

function extractAuditAnswers(
  reference: KbfReferenceV1,
  validJobs: Array<{ job: StoredAuditJob }>,
): Array<number | null> {
  const answers = new Array<number | null>(reference.probes.length).fill(null)
  for (const { job } of validJobs) {
    if (!job.responseBytes) continue
    const response = decodeHttpResponse(job.responseBytes)
    const text = extractCompletionText(response.body)
    if (text === null) continue
    const parsed = parseKbfAnswers(text, reference.probes.length)
    const start = job.jobIndex * 10
    for (let index = start; index < Math.min(start + 10, answers.length); index += 1) {
      answers[index] = parsed[index] ?? null
    }
  }
  return answers
}

function extractCompletionText(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
      content?: Array<{ type?: string; text?: unknown }>
    }
    const chat = parsed.choices?.[0]?.message?.content
    if (typeof chat === 'string') return chat
    const completion = parsed.choices?.[0]?.text
    if (typeof completion === 'string') return completion
    const anthropic = parsed.content?.find((block) => block.type === 'text')?.text
    return typeof anthropic === 'string' ? anthropic : null
  } catch {
    return null
  }
}

function buildMetricSnapshot(plan: CommittedAuditPlan, jobs: CanonicalAuditEvidenceJobV2[]): MetricSnapshot {
  const valid = jobs.filter((job) => job.parsedResponseAuth !== null)
  return {
    windowStartedAt: plan.executeAfter,
    windowEndedAt: plan.executeBefore,
    eligibleAttempts: plan.jobCount,
    successfulAttempts: valid.length,
    p50TtftMs: 0,
    p95TtftMs: 0,
    p50OutputTokensPerSecondMilli: 0,
    schemaVersion: 1,
    observationsRoot: plan.auditJobRoot,
  }
}

function toContractJob(job: StoredAuditJob): AuditJob {
  return {
    auditId: job.auditId,
    jobIndex: job.jobIndex,
    sellerPeerId: peerIdToAddress(job.sellerPeerId),
    serviceHash: job.serviceHash,
    requestHash: job.requestHash,
    jobSalt: job.jobSalt,
    executeAfter: job.executeAfter,
    executeBefore: job.executeBefore,
  }
}

function toRelayAssignment(plan: CommittedAuditPlan, job: StoredAuditJob): RelayAssignment {
  const assigned = requireAssignedAuditJob(job)
  return {
    auditId: assigned.auditId,
    jobIndex: assigned.jobIndex,
    attempt: assigned.assignmentAttempt,
    relayBuyer: assigned.relayBuyerAddress,
    payoutPerJobUsdc: plan.payoutPerJobUsdc,
    executeAfter: assigned.executeAfter,
    executeBefore: assigned.executeBefore,
  }
}

function normalizeAttestableVerdict(verdict: FingerprintVerdict): Exclude<FingerprintVerdict, 'UNKNOWN'> {
  return verdict === 'UNKNOWN' ? 'UNDETERMINED' : verdict
}

function verdictCode(verdict: Exclude<FingerprintVerdict, 'UNKNOWN'>): Exclude<VerifierVerdict, 0> {
  if (verdict === 'SAME') return VERIFIER_VERDICT_SAME
  if (verdict === 'DIFF') return VERIFIER_VERDICT_DIFF
  return VERIFIER_VERDICT_UNDETERMINED
}

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`
}
