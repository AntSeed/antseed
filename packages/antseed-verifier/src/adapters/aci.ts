import type { ProviderAdapter, ProviderEvidence } from './index.js'

/**
 * RedPill / ACI provider adapter (in-process). It gets a fresh, nonce-bound attestation from a
 * Private-AI-Gateway (ACI spec) endpoint, reads the TDX quote, and binds via aci-keyset-v1
 * (report_data = keysetDigest ‖ nonce). ANTSEED_VERIFIER_PROVIDER_ADAPTER=aci selects it.
 *
 * Env: ACI_ATTESTATION_URL (required, e.g. https://<gateway>/v1/aci/attestation), ACI_API_KEY (optional Bearer).
 */

const TIMEOUT_MS = 20_000

interface AciReport {
  workload_keyset_digest?: string
  attestation?: { evidence?: { quote?: string } }
}

/** Read the 64-hex keyset digest from ACI's "sha256:<hex>" field. */
function keysetDigestHex(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('aci report missing workload_keyset_digest')
  const hex = raw.replace(/^sha256:/, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('aci workload_keyset_digest is not "sha256:<64 hex>"')
  return hex
}

async function fetchEvidence(nonce: Uint8Array, env: Record<string, string | undefined>): Promise<ProviderEvidence> {
  const url = env['ACI_ATTESTATION_URL']
  if (!url) throw new Error('ACI_ATTESTATION_URL is required (e.g. https://<gateway>/v1/aci/attestation)')

  const nonceHex = Buffer.from(nonce).toString('hex')
  const full = `${url}${url.includes('?') ? '&' : '?'}nonce=${nonceHex}`
  const headers: Record<string, string> = {}
  const key = env['ACI_API_KEY']
  if (key) headers['authorization'] = `Bearer ${key}`

  const resp = await fetch(full, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`aci attestation HTTP ${resp.status}`)

  const report = (await resp.json()) as AciReport
  const quoteHex = report?.attestation?.evidence?.quote
  if (typeof quoteHex !== 'string' || quoteHex.length === 0) {
    throw new Error('aci report has no attestation.evidence.quote')
  }
  return {
    quote: new Uint8Array(Buffer.from(quoteHex.replace(/^0x/, ''), 'hex')),
    bindingScheme: 'aci-keyset-v1',
    ingredients: { keysetDigest: keysetDigestHex(report.workload_keyset_digest) },
  }
}

const adapter: ProviderAdapter = { id: 'aci', fetchEvidence }
export default adapter
