import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  canonicalHashBytes32,
  canonicalJsonStringify,
  type AuditResultFragment,
  type KbfReferenceV1,
  type KbfReferenceSelfTestV1,
} from '@antseed/fingerprints'
import type {
  ParsedResponseAuth,
  RelayTreasuryReservation,
} from '@antseed/node/payments'
import type {
  StoredAuditJob,
} from '@antseed/node'
import type { CommittedAuditPlan } from './audit-state.js'

export interface CanonicalAuditEvidenceJobV2 {
  jobIndex: number
  state: StoredAuditJob['state']
  relayPeerId: string | null
  relayBuyerAddress: string | null
  assignmentAttempt: number
  assignmentSignature: string | null
  sellerPeerId: string
  service: string
  serviceHash: string
  requestHash: string
  jobSalt: string
  executeAfter: number
  executeBefore: number
  positionalProof: string[]
  requestBytesBase64: string
  responseBytesBase64: string | null
  responseAuthPayloadBase64: string | null
  parsedResponseAuth: ParsedResponseAuth | null
  sellerChargeUsdc: string | null
  paymentMetadata: Record<string, unknown> | null
  failureKind: string | null
  failureMessage: string | null
  relayPaid: boolean
}

export interface CanonicalAuditEvidenceV2 {
  version: 2
  audit: {
    auditId: string
    chainId: string
    registryAddress: string
    treasuryAddress: string
    verifierAddress: string
    agentId: string
    targetPeerId: string
    targetService: string
    targetServiceHash: string
    targetSalt: string
    targetCommitment: string
    probeRoot: string
    auditJobRoot: string
    referenceId: string
    queryProfileHash: string
    verifierConfigHash: string
    probeCount: number
    jobCount: number
    requiredRelayCount: number
    payoutPerJobUsdc: string
    reservedBudgetUsdc: string
    executeAfter: number
    executeBefore: number
    forceClaimAvailableAt: number
    forceClaimDeadline: number
    commitTxHash: string | null
  }
  reference: KbfReferenceV1
  exactSubsetBaseline: KbfReferenceSelfTestV1
  jobs: CanonicalAuditEvidenceJobV2[]
  kbf: AuditResultFragment
  validation: {
    validJobCount: number
    newlyPayableClaimCount: number
    alreadyPaidValidJobCount: number
    distinctRelayCount: number
    requiredRelayCount: number
    coverage: number
    duplicateJobIndexes: number[]
    duplicateRequestHashes: string[]
  }
  availability: {
    attemptedJobs: number
    successfulJobs: number
    failedJobs: number
    parsedProbeCount: number
    totalProbeCount: number
  }
  performance: {
    responseLatencyMs: number[]
    p50ResponseLatencyMs: number
    p95ResponseLatencyMs: number
    outputTokensPerSecondMilli: number[]
    p50OutputTokensPerSecondMilli: number
  }
  usage: {
    epochStartedAt: number
    epochEndedAt: number
    modelShareBps: number
    attributionAvailable: boolean
  }
  treasury: {
    reservation: SerializedReservation
    relayPaidBitmap: string
  }
  verifierConfiguration: Record<string, unknown>
  createdAt: string
}

interface SerializedReservation {
  epoch: string
  jobCount: number
  paidJobCount: number
  payoutPerJobUsdc: string
  totalBudgetUsdc: string
  remainingBudgetUsdc: string
  releaseAfter: number
  released: boolean
}

export function createCanonicalAuditEvidenceV2(input: {
  plan: CommittedAuditPlan
  reference: KbfReferenceV1
  exactSubsetBaseline: KbfReferenceSelfTestV1
  jobs: CanonicalAuditEvidenceJobV2[]
  kbf: AuditResultFragment
  reservation: RelayTreasuryReservation
  relayPaidBitmap: bigint
  modelShareBps: number
  usageAttributionAvailable: boolean
  epochStartedAt: number
  epochEndedAt: number
  verifierConfiguration: Record<string, unknown>
  createdAt?: Date
}): CanonicalAuditEvidenceV2 {
  const validJobs = input.jobs.filter((job) => job.parsedResponseAuth !== null)
  const newClaims = validJobs.filter((job) => !job.relayPaid)
  const paidClaims = validJobs.filter((job) => job.relayPaid)
  const distinctRelays = new Set(validJobs.map((job) => job.relayBuyerAddress?.toLowerCase()).filter(Boolean))
  const responseLatencies = validJobs.map((job) => {
    const auth = job.parsedResponseAuth!
    return Math.max(0, auth.responseCompletedAt - auth.responseStartedAt)
  })
  const throughput = validJobs.map(() => 0)
  return {
    version: 2,
    audit: serializePlan(input.plan),
    reference: input.reference,
    exactSubsetBaseline: input.exactSubsetBaseline,
    jobs: input.jobs,
    kbf: input.kbf,
    validation: {
      validJobCount: validJobs.length,
      newlyPayableClaimCount: newClaims.length,
      alreadyPaidValidJobCount: paidClaims.length,
      distinctRelayCount: distinctRelays.size,
      requiredRelayCount: input.plan.requiredRelayCount,
      coverage: input.plan.jobCount === 0 ? 0 : validJobs.length / input.plan.jobCount,
      duplicateJobIndexes: duplicates(input.jobs.map((job) => job.jobIndex)),
      duplicateRequestHashes: duplicates(input.jobs.map((job) => job.requestHash.toLowerCase())),
    },
    availability: {
      attemptedJobs: input.jobs.length,
      successfulJobs: input.jobs.filter((job) => job.state === 'succeeded').length,
      failedJobs: input.jobs.filter((job) => job.state !== 'succeeded').length,
      parsedProbeCount: input.kbf.parsedProbeCount,
      totalProbeCount: input.kbf.probeCount,
    },
    performance: {
      responseLatencyMs: responseLatencies,
      p50ResponseLatencyMs: percentile(responseLatencies, 0.5),
      p95ResponseLatencyMs: percentile(responseLatencies, 0.95),
      outputTokensPerSecondMilli: throughput,
      p50OutputTokensPerSecondMilli: percentile(throughput, 0.5),
    },
    usage: {
      epochStartedAt: input.epochStartedAt,
      epochEndedAt: input.epochEndedAt,
      modelShareBps: input.modelShareBps,
      attributionAvailable: input.usageAttributionAvailable,
    },
    treasury: {
      reservation: serializeReservation(input.reservation),
      relayPaidBitmap: input.relayPaidBitmap.toString(),
    },
    verifierConfiguration: input.verifierConfiguration,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  }
}

export function canonicalEvidenceBytes(evidence: CanonicalAuditEvidenceV2): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(evidence))
}

export function canonicalEvidenceHash(evidence: CanonicalAuditEvidenceV2): string {
  return canonicalHashBytes32(evidence)
}

export async function writeCanonicalEvidence(path: string, evidence: CanonicalAuditEvidenceV2): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, canonicalEvidenceBytes(evidence))
}

export async function verifyCanonicalEvidenceFile(path: string, expectedHash: string): Promise<void> {
  const bytes = await readFile(path)
  const parsed = JSON.parse(bytes.toString('utf8')) as CanonicalAuditEvidenceV2
  const canonical = canonicalEvidenceBytes(parsed)
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) throw new Error('evidence file is not canonical JSON')
  if (canonicalEvidenceHash(parsed).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error('evidence file hash mismatch')
  }
}

function serializePlan(plan: CommittedAuditPlan): CanonicalAuditEvidenceV2['audit'] {
  return {
    auditId: plan.auditId,
    chainId: plan.chainId,
    registryAddress: plan.registryAddress,
    treasuryAddress: plan.treasuryAddress,
    verifierAddress: plan.verifierAddress,
    agentId: plan.agentId,
    targetPeerId: plan.targetPeerId,
    targetService: plan.targetService,
    targetServiceHash: plan.targetServiceHash,
    targetSalt: plan.targetSalt,
    targetCommitment: plan.targetCommitment,
    probeRoot: plan.probeRoot,
    auditJobRoot: plan.auditJobRoot,
    referenceId: plan.referenceId,
    queryProfileHash: plan.queryProfileHash,
    verifierConfigHash: plan.verifierConfigHash,
    probeCount: plan.probeCount,
    jobCount: plan.jobCount,
    requiredRelayCount: plan.requiredRelayCount,
    payoutPerJobUsdc: plan.payoutPerJobUsdc.toString(),
    reservedBudgetUsdc: plan.reservedBudgetUsdc.toString(),
    executeAfter: plan.executeAfter,
    executeBefore: plan.executeBefore,
    forceClaimAvailableAt: plan.forceClaimAvailableAt,
    forceClaimDeadline: plan.forceClaimDeadline,
    commitTxHash: plan.commitTxHash,
  }
}

function serializeReservation(reservation: RelayTreasuryReservation): SerializedReservation {
  return {
    epoch: reservation.epoch.toString(),
    jobCount: reservation.jobCount,
    paidJobCount: reservation.paidJobCount,
    payoutPerJobUsdc: reservation.payoutPerJobUsdc.toString(),
    totalBudgetUsdc: reservation.totalBudgetUsdc.toString(),
    remainingBudgetUsdc: reservation.remainingBudgetUsdc.toString(),
    releaseAfter: reservation.releaseAfter,
    released: reservation.released,
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function duplicates<T extends string | number>(values: readonly T[]): T[] {
  const seen = new Set<T>()
  const duplicate = new Set<T>()
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value)
    seen.add(value)
  }
  return [...duplicate]
}
