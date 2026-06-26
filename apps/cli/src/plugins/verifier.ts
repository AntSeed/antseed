import { ANTSEED_ATTEST_PATH, type SellerRequest, type SellerResponse } from '@antseed/node'
import { loadVerifierPlugin } from './loader.js'
import { TRUSTED_PLUGINS } from './registry.js'

export const ANTSEED_VERIFIER_SDKS_ENV = 'ANTSEED_VERIFIER_SDKS'
const VSDK = 'verifier.'
const VSDK_DEFAULT = 'verifier-default.'
const VERIFIER_ID_RE = /^[a-z0-9][a-z0-9.-]*$/

function isVerifierId(id: string): boolean {
  return VERIFIER_ID_RE.test(id)
}

export function normalizeVerifierIds(raw: string): string[] {
  const ids = raw.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean)
  for (const id of ids) {
    if (!isVerifierId(id)) {
      throw new Error(`invalid verifier id "${id}": use lowercase letters, digits, hyphen, or dot`)
    }
  }
  return Array.from(new Set(ids))
}

export function buildVerifierCapabilities(ids: string[]): string[] {
  const clean = normalizeVerifierIds(ids.join(','))
  return clean.flatMap((id, i) => (i === 0 ? [`${VSDK}${id}`, `${VSDK_DEFAULT}${id}`] : [`${VSDK}${id}`]))
}

export function parseVerifierCapabilities(caps: string[] | undefined): { supported: string[]; default?: string } {
  const supported: string[] = []
  let dflt: string | undefined
  for (const cap of caps ?? []) {
    const isDefault = cap.startsWith(VSDK_DEFAULT)
    const raw = isDefault
      ? cap.slice(VSDK_DEFAULT.length)
      : cap.startsWith(VSDK)
        ? cap.slice(VSDK.length)
        : ''
    const id = raw.trim().toLowerCase()
    if (!isVerifierId(id)) continue
    if (!supported.includes(id)) supported.push(id)
    if (isDefault) dflt = id
  }
  return dflt ? { supported, default: dflt } : { supported }
}

export function curatedVerifierIds(): Set<string> {
  return new Set(TRUSTED_PLUGINS.filter((p) => p.type === 'verifier').map((p) => p.name))
}

export interface VerifierPolicy {
  prefer?: string[]
  require: boolean
}

export function selectVerifier(
  policy: VerifierPolicy,
  sup: { supported: string[]; default?: string },
): string | null {
  for (const id of policy.prefer ?? []) {
    if (sup.supported.includes(id)) return id
  }
  if ((policy.prefer ?? []).length > 0) return null
  const curated = curatedVerifierIds()
  if (sup.default && curated.has(sup.default)) return sup.default
  return sup.supported.find((id) => curated.has(id)) ?? null
}

export type SellerReach = (req: SellerRequest) => Promise<SellerResponse>

export interface VerifyOutcome {
  ok: boolean
  verified: boolean
  sdk?: string
  reason?: string
}

export async function runVerifier(
  policy: VerifierPolicy,
  peerId: string,
  caps: string[] | undefined,
  reach: SellerReach,
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  const sup = parseVerifierCapabilities(caps)
  const chosen = selectVerifier(policy, sup)
  if (!chosen) return { ok: !policy.require, verified: false, reason: 'no supported + trusted verifier' }
  let sdk
  try {
    sdk = await loadVerifierPlugin(chosen)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `install/load failed: ${reason}` }
  }
  if (sdk.name !== chosen) {
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verifier package exported name "${sdk.name}", expected "${chosen}"` }
  }
  try {
    const result = await sdk.verify({
      peerId,
      verifierId: chosen,
      attestPath: `${ANTSEED_ATTEST_PATH}/${encodeURIComponent(chosen)}`,
      fetchFromSeller: reach,
      ...(signal ? { signal } : {}),
    })
    if (result.ok) return { ok: true, verified: true, sdk: chosen }
    const failed = result.claims.filter((c) => !c.ok).map((c) => `${c.claim}: ${c.detail ?? 'failed'}`).join('; ')
    return { ok: !policy.require, verified: false, sdk: chosen, reason: failed || 'verifier returned not-ok' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verify error: ${reason}` }
  }
}
