import type { StoredAuditJob, StoredAuditPlan } from '@antseed/node'

export type CommittedAuditPlan = StoredAuditPlan & {
  chainId: string
  registryAddress: string
  treasuryAddress: string
  verifierAddress: string
  agentId: string
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
  payoutPerJobUsdc: bigint
  reservedBudgetUsdc: bigint
  executeAfter: number
  executeBefore: number
  forceClaimAvailableAt: number
  forceClaimDeadline: number
}

export type AssignedAuditJob = StoredAuditJob & {
  relayPeerId: string
  relayBuyerAddress: string
  assignmentSignature: string
}

const COMMITTED_STRING_FIELDS = [
  'chainId',
  'registryAddress',
  'treasuryAddress',
  'verifierAddress',
  'agentId',
  'targetServiceHash',
  'targetSalt',
  'targetCommitment',
  'probeRoot',
  'auditJobRoot',
  'referenceId',
  'queryProfileHash',
  'verifierConfigHash',
] as const

const COMMITTED_NUMBER_FIELDS = [
  'probeCount',
  'jobCount',
  'requiredRelayCount',
  'executeAfter',
  'executeBefore',
  'forceClaimAvailableAt',
  'forceClaimDeadline',
] as const

export function requireCommittedAuditPlan(plan: StoredAuditPlan): CommittedAuditPlan {
  for (const field of COMMITTED_STRING_FIELDS) {
    if (typeof plan[field] !== 'string' || plan[field].length === 0) {
      throw new Error(`audit ${plan.auditId} is missing committed field ${field}`)
    }
  }
  for (const field of COMMITTED_NUMBER_FIELDS) {
    if (!Number.isInteger(plan[field])) throw new Error(`audit ${plan.auditId} is missing committed field ${field}`)
  }
  if (plan.payoutPerJobUsdc === null) throw new Error(`audit ${plan.auditId} is missing committed payout`)
  if (plan.reservedBudgetUsdc === null) throw new Error(`audit ${plan.auditId} is missing committed budget`)
  return plan as CommittedAuditPlan
}

export function requireAssignedAuditJob(job: StoredAuditJob): AssignedAuditJob {
  if (!job.relayPeerId || !job.relayBuyerAddress || !job.assignmentSignature) {
    throw new Error(`audit job ${job.auditId}/${job.jobIndex} has no persisted relay assignment`)
  }
  return job as AssignedAuditJob
}
