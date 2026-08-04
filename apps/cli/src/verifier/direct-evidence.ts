import { open, readFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalHashBytes32,
  canonicalJsonStringify,
  type AuditStats,
  type FingerprintVerdict,
  type KbfProbe,
  type MatchVector,
  type ReferenceQueryProfileV1,
} from '@antseed/fingerprints'
import type { MetricSnapshot, ResponseAuthPayload } from '@antseed/node'

export interface DirectAuditEvidenceExchange {
  requestId: string
  probeIds: string[]
  request: {
    method: string
    path: string
    headers: Record<string, string>
    bodyBase64: string
    hash: string
  }
  response: {
    statusCode: number
    headers: Record<string, string>
    bodyBase64: string
    hash: string
  } | null
  responseAuth: ResponseAuthPayload | null
  payment: {
    sellerChargeUsdc: string
    spendingAuth: Record<string, unknown>
  } | null
  timing: {
    startedAt: number
    completedAt: number
    responseLatencyMs: number
    outputTokens: number
    outputTokensPerSecondMilli: number
  }
  answers: Array<number | null>
  matches: Array<0 | 1 | null>
  status: 'succeeded' | 'failed'
  failureReason: string | null
}

export interface DirectAuditEvidenceV1 {
  version: 1
  kind: 'antseed-direct-kbf-audit'
  createdAt: string
  verifier: {
    peerId: string
    address: string
  }
  target: {
    peerId: string
    agentId: string
    sellerAddress: string
    service: string
    serviceHash: string
  }
  reference: {
    referenceId: string
    referenceModel: string
    queryProfileHash: string
    queryProfile: ReferenceQueryProfileV1
    statisticalPower: number
    statisticalPowerEvidence: Record<string, unknown>
    selfTest: {
      hamming: number
      total: number
      coverage: number
      errorRate: number
    }
    probes: KbfProbe[]
  }
  exchanges: DirectAuditEvidenceExchange[]
  result: {
    selectedProbeCount: number
    authenticatedProbeCount: number
    parsedProbeCount: number
    matchVector: MatchVector
    matchVectorHash: string
    stats: AuditStats
    verdict: Exclude<FingerprintVerdict, 'UNKNOWN'>
    verdictReason: string | null
  }
  metrics: MetricSnapshot
}

export function directAuditEvidenceHash(evidence: DirectAuditEvidenceV1): string {
  return canonicalHashBytes32(evidence)
}

export function deriveDirectAuditId(input: {
  verifierAddress: string
  targetPeerId: string
  agentId: string
  serviceHash: string
  completedAt: number
  evidenceHash: string
}): string {
  return canonicalHashBytes32({
    domain: 'antseed-direct-audit-id-v1',
    verifierAddress: input.verifierAddress.toLowerCase(),
    targetPeerId: input.targetPeerId.toLowerCase(),
    agentId: input.agentId,
    serviceHash: input.serviceHash.toLowerCase(),
    completedAt: input.completedAt,
    evidenceHash: input.evidenceHash.toLowerCase(),
  })
}

export async function writeDirectAuditEvidence(
  evidenceDir: string,
  auditId: string,
  evidence: DirectAuditEvidenceV1,
): Promise<{ path: string; evidenceHash: string }> {
  const evidenceHash = directAuditEvidenceHash(evidence)
  const bytes = new TextEncoder().encode(canonicalJsonStringify(evidence))
  await mkdir(evidenceDir, { recursive: true })
  const path = join(evidenceDir, `${auditId}.json`)
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(temporaryPath, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporaryPath, path)
  return { path, evidenceHash }
}

export async function verifyDirectAuditEvidenceFile(path: string, expectedHash: string): Promise<DirectAuditEvidenceV1> {
  const bytes = await readFile(path)
  const parsed = JSON.parse(bytes.toString('utf8')) as DirectAuditEvidenceV1
  const canonical = new TextEncoder().encode(canonicalJsonStringify(parsed))
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) throw new Error('evidence file is not canonical JSON')
  if (directAuditEvidenceHash(parsed).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error('evidence file hash mismatch')
  }
  return parsed
}
