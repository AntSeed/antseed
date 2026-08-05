import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalHashBytes32,
  canonicalJsonStringify,
  type FingerprintStats,
  type FingerprintVerdict,
  type KbfProbe,
  type MatchVector,
  type ReferenceQueryProfileV1,
} from '@antseed/fingerprints'

export interface ProxyAuditEvidenceExchange {
  batchIndex: number
  attemptCount: number
  probeIds: string[]
  request: {
    method: 'POST'
    url: string
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
  timing: {
    startedAt: number
    completedAt: number
    responseLatencyMs: number
  }
  answers: Array<number | null>
  matches: MatchVector
  status: 'succeeded' | 'failed'
  failureReason: string | null
}

export interface ProxyAuditEvidenceV1 {
  version: 1
  kind: 'antseed-buyer-proxy-kbf-audit'
  evidenceLevel: 'proxy-observation-no-response-auth-or-payment-evidence'
  createdAt: string
  buyerProxy: {
    baseUrl: string
    statePath: string
    pid: number
  }
  target: {
    peerId: string
    displayName: string | null
    agentId: string | null
    service: string
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
  exchanges: ProxyAuditEvidenceExchange[]
  result: {
    selectedProbeCount: number
    parsedProbeCount: number
    matchVector: MatchVector
    matchVectorHash: string
    stats: FingerprintStats
    verdict: Exclude<FingerprintVerdict, 'UNKNOWN'>
    verdictReason: string | null
  }
}

export function proxyAuditEvidenceHash(evidence: ProxyAuditEvidenceV1): string {
  return canonicalHashBytes32(evidence)
}

export function deriveProxyAuditId(input: {
  targetPeerId: string
  referenceId: string
  completedAt: number
  evidenceHash: string
}): string {
  return canonicalHashBytes32({
    domain: 'antseed-buyer-proxy-audit-id-v1',
    targetPeerId: input.targetPeerId.toLowerCase(),
    referenceId: input.referenceId,
    completedAt: input.completedAt,
    evidenceHash: input.evidenceHash.toLowerCase(),
  })
}

export async function writeProxyAuditEvidence(
  evidenceDir: string,
  auditId: string,
  evidence: ProxyAuditEvidenceV1,
): Promise<{ path: string; evidenceHash: string }> {
  const evidenceHash = proxyAuditEvidenceHash(evidence)
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

export async function verifyProxyAuditEvidenceFile(
  path: string,
  expectedHash: string,
): Promise<ProxyAuditEvidenceV1> {
  const bytes = await readFile(path)
  const parsed = JSON.parse(bytes.toString('utf8')) as ProxyAuditEvidenceV1
  const canonical = new TextEncoder().encode(canonicalJsonStringify(parsed))
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) throw new Error('evidence file is not canonical JSON')
  if (proxyAuditEvidenceHash(parsed).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error('evidence file hash mismatch')
  }
  return parsed
}
