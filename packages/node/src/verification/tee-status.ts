export const TEE_VERIFIER_ID = 'antseed-verifier'
export const TEE_MAX_AGE_MS = 5 * 60_000
export const TEE_BADGE_MAX_AGE_MS = 24 * 60 * 60_000
export const TEE_REQUIRED_CLAIMS = [
  'antseed-verifier:seller-node-tee-genuine',
  'antseed-verifier:seller-bound',
] as const

export type TeeMode = 'optional' | 'required'
export interface TeeClaim {
  claim: string
  ok: boolean
  detail?: string
}
export interface TeeEvidence {
  peerId: string
  verifierId: string
  verifierVersion?: string
  fingerprint: string
  checkedAt: number
  expiresAt: number
  sellerNodeVerified: boolean
  claims: TeeClaim[]
  reason?: string
  checking?: boolean
  unavailable?: boolean
}
export interface TeeSnapshot {
  sessionId: string
  mode: TeeMode
  verificationEnabled: boolean
  routingPaused?: boolean
  requireVerifier?: boolean
  preferredVerifierIds?: string[]
  evidence: TeeEvidence[]
}
export interface DesktopTeeStatus {
  configuredMode: TeeMode
  snapshot: TeeSnapshot | null
  applying?: boolean
  error?: string
}

export function passedSellerNodeClaims(claims: readonly TeeClaim[]): boolean {
  return TEE_REQUIRED_CLAIMS.every((required) => {
    const matches = claims.filter((claim) => claim.claim === required)
    return matches.length > 0 && matches.every((claim) => claim.ok === true)
  })
}

export function teeBadgeLabel(evidence: TeeEvidence | undefined, now = Date.now()): string {
  if (evidence?.checking) return 'Checking TEE…'
  if (evidence?.unavailable) return 'Verification unavailable'
  if (!evidence) return 'TEE advertised'
  if (evidence.sellerNodeVerified) {
    return evidence.expiresAt > now ? 'Seller node verified' : 'TEE advertised'
  }
  return 'Verification failed'
}

export function teeControlFileName(port: number): string {
  return `buyer-verification-${port}.json`
}
