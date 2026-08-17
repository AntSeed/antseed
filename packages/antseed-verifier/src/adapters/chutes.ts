import type { ProviderAdapter, ProviderEvidence } from './index.js'
import type { NvidiaGpuEvidence } from '../nras.js'

/**
 * Chutes provider adapter (in-process). The Chutes evidence endpoint needs Bearer auth and
 * returns an array of instances. The adapter adds the auth, picks one instance, decodes the
 * base64 quote, and reshapes the flat GPU evidence into the NRAS shape.
 * ANTSEED_VERIFIER_PROVIDER_ADAPTER=chutes selects it.
 *
 * Env: CHUTES_API_KEY (required), CHUTES_CHUTE (required), CHUTES_API_BASE (default https://api.chutes.ai).
 */

const DEFAULT_BASE = 'https://api.chutes.ai'
const TIMEOUT_MS = 20_000

interface ChutesInstance {
  quote?: string
  e2e_pubkey?: string
  gpu_evidence?: unknown
}

/** Reshape Chutes' flat GPU evidence [{arch, evidence, certificate}] → NRAS { arch, evidence_list }. */
function reshapeGpu(gpu: unknown): NvidiaGpuEvidence | undefined {
  if (!gpu) return undefined
  if (Array.isArray(gpu)) {
    if (gpu.length === 0) return undefined
    const first = gpu[0] as { arch?: string }
    return {
      arch: String(first.arch),
      evidence_list: gpu.map((g) => {
        const item = g as { evidence?: string; certificate?: string }
        return { evidence: String(item.evidence), certificate: String(item.certificate) }
      }),
    }
  }
  return gpu as NvidiaGpuEvidence
}

async function fetchEvidence(nonce: Uint8Array, env: Record<string, string | undefined>): Promise<ProviderEvidence> {
  const base = (env['CHUTES_API_BASE'] ?? DEFAULT_BASE).replace(/\/+$/, '')
  const key = env['CHUTES_API_KEY']
  const chute = env['CHUTES_CHUTE']
  if (!key) throw new Error('CHUTES_API_KEY is required')
  if (!chute) throw new Error('CHUTES_CHUTE is required')

  const nonceHex = Buffer.from(nonce).toString('hex')
  const url = `${base}/chutes/${encodeURIComponent(chute)}/evidence?nonce=${nonceHex}`
  const resp = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`chutes evidence HTTP ${resp.status}`)

  const body = (await resp.json()) as unknown
  const instances = (Array.isArray(body) ? body : [body]) as ChutesInstance[]
  const inst = instances.find((i) => typeof i?.quote === 'string' && i.quote.length > 0)
  if (!inst?.quote) throw new Error('no chutes instance returned a quote')

  const evidence: ProviderEvidence = {
    quote: new Uint8Array(Buffer.from(inst.quote, 'base64')),
    bindingScheme: 'nonce-pubkey-sha256-v1',
    ingredients: { e2ePubkey: inst.e2e_pubkey },
  }
  const gpu = reshapeGpu(inst.gpu_evidence)
  if (gpu) evidence.gpuEvidence = gpu
  return evidence
}

const adapter: ProviderAdapter = { id: 'chutes', fetchEvidence }
export default adapter
