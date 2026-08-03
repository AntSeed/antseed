import { ANTSEED_ATTEST_PATH, type SellerRequest, type SellerResponse } from '@antseed/node'
import { loadVerifierPlugin } from './loader.js'
import { TRUSTED_VERIFIER_PLUGINS } from './registry.js'

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
  return new Set(TRUSTED_VERIFIER_PLUGINS.map((p) => p.name))
}

export interface VerifierPolicy {
  prefer?: string[]
  require: boolean
}

/**
 * Resolve buyer verifier CLI flags into a policy. `--no-verifier` (verifier === false)
 * disables verification; combining it with `--require-verifier` or `--verifiers` is a
 * contradiction and is rejected rather than silently disabling verification.
 */
export function resolveVerifierPolicy(opts: {
  verifier?: boolean
  verifiers?: string
  requireVerifier?: boolean
}): VerifierPolicy | undefined {
  if (opts.verifier === false) {
    if (opts.requireVerifier || opts.verifiers) {
      throw new Error('--no-verifier cannot be combined with --require-verifier or --verifiers')
    }
    return undefined
  }
  return { prefer: normalizeVerifierIds(opts.verifiers ?? ''), require: Boolean(opts.requireVerifier) }
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
  /** True for install/network/timeout failures — a transient outcome must not be cached. */
  transient?: boolean
}

/** Stable fingerprint of a peer's verifier-relevant capabilities. */
export function verifierSupportFingerprint(caps: string[] | undefined): string {
  const sup = parseVerifierCapabilities(caps)
  return `${sup.default ?? ''}|${[...sup.supported].sort().join(',')}`
}

/** Upper bound on a single verification (attest round-trip + quote check). */
export const VERIFY_TIMEOUT_MS = 30_000

export async function withVerifyTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<T> {
  const ac = new AbortController()
  const abort = (reason: unknown): void => { if (!ac.signal.aborted) ac.abort(reason) }
  const onOuter = (): void => abort(outer?.reason ?? new Error('verification aborted'))
  if (outer?.aborted) abort(outer.reason ?? new Error('verification aborted'))
  else outer?.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => abort(new Error(`verification timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([
      run(ac.signal),
      new Promise<never>((_, reject) => {
        const fail = (): void => {
          const r = ac.signal.reason
          reject(r instanceof Error ? r : new Error('verification aborted'))
        }
        // The signal may already be aborted (e.g. the client had disconnected before
        // we started); a listener added after that never fires, so reject eagerly.
        if (ac.signal.aborted) fail()
        else ac.signal.addEventListener('abort', fail, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onOuter)
  }
}

export async function runVerifier(
  policy: VerifierPolicy,
  peerId: string,
  caps: string[] | undefined,
  makeReach: (chosenId: string) => SellerReach,
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  const sup = parseVerifierCapabilities(caps)
  const chosen = selectVerifier(policy, sup)
  if (!chosen) return { ok: !policy.require, verified: false, reason: 'no supported + trusted verifier' }
  const reach = makeReach(chosen)
  let sdk
  try {
    sdk = await loadVerifierPlugin(chosen, { install: false })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verifier not prepared: ${reason}`, transient: true }
  }
  if (sdk.name !== chosen) {
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verifier package exported name "${sdk.name}", expected "${chosen}"` }
  }
  try {
    const result = await withVerifyTimeout(
      async (verifySignal) => sdk.verify({
        peerId,
        verifierId: chosen,
        attestPath: `${ANTSEED_ATTEST_PATH}/${encodeURIComponent(chosen)}`,
        fetchFromSeller: reach,
        signal: verifySignal,
      }),
      signal,
    )
    if (result.ok) return { ok: true, verified: true, sdk: chosen }
    const failed = result.claims.filter((c) => !c.ok).map((c) => `${c.claim}: ${c.detail ?? 'failed'}`).join('; ')
    return { ok: !policy.require, verified: false, sdk: chosen, reason: failed || 'verifier returned not-ok' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verify error: ${reason}`, transient: true }
  }
}

export interface CachedVerdict {
  outcome: VerifyOutcome
  expires: number
}

export async function getCachedVerdict(
  cache: Map<string, CachedVerdict>,
  key: string,
  now: number,
  ttlMs: number,
  maxEntries: number,
  run: () => Promise<VerifyOutcome>,
): Promise<VerifyOutcome> {
  const cached = cache.get(key)
  if (cached && cached.expires > now) return cached.outcome
  if (cached) cache.delete(key)

  const outcome = await run()
  if (!outcome.transient) {
    if (cache.size >= maxEntries) {
      for (const [k, v] of cache) if (v.expires <= now) cache.delete(k)
      while (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    }
    cache.set(key, { outcome, expires: now + ttlMs })
  }
  return outcome
}
