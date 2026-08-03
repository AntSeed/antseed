import { randomBytes } from 'node:crypto'
import type { StoredAuditPlan } from '@antseed/node'

export function createQueuedAuditPlan(input: {
  source: 'manual' | 'automatic'
  epoch?: bigint | string | null
  durationMs: number
  targetPeerId: string
  targetService: string
  agentId?: string | null
  jobTimeoutMs: number
  now?: number
}): StoredAuditPlan {
  const now = input.now ?? Date.now()
  return {
    auditId: `0x${randomBytes(32).toString('hex')}`,
    state: 'queued',
    source: input.source,
    epoch: input.epoch === undefined || input.epoch === null ? null : String(input.epoch),
    durationMs: input.durationMs,
    chainId: null,
    registryAddress: null,
    treasuryAddress: null,
    verifierAddress: null,
    agentId: input.agentId ?? null,
    targetPeerId: normalizePeerId(input.targetPeerId),
    targetService: input.targetService.trim(),
    targetServiceHash: null,
    targetSalt: null,
    targetCommitment: null,
    probeRoot: null,
    auditJobRoot: null,
    referenceId: null,
    queryProfileHash: null,
    verifierConfigHash: null,
    probeCount: null,
    jobCount: null,
    requiredRelayCount: null,
    jobTimeoutMs: input.jobTimeoutMs,
    payoutPerJobUsdc: null,
    reservedBudgetUsdc: null,
    commitTxHash: null,
    attestationTxHash: null,
    evidenceHash: null,
    evidenceUri: null,
    evidenceState: 'none',
    executeAfter: null,
    executeBefore: null,
    forceClaimAvailableAt: null,
    forceClaimDeadline: null,
    createdAt: now,
    updatedAt: now,
    failureReason: null,
  }
}

export function normalizePeerId(value: string): string {
  const normalized = value.startsWith('0x') ? value.slice(2) : value
  if (!/^[0-9a-fA-F]{40}$/.test(normalized)) throw new Error('peer id must be a 40-character EVM address')
  return normalized.toLowerCase()
}
