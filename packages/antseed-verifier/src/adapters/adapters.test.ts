import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { loadAdapter, adapterIds } from './index.js'

/** Start a stub provider HTTP server. Return its base URL and a handle to close it. */
async function startStub(handler: (url: URL, auth: string | undefined) => { status: number; body: unknown } | null): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const out = handler(url, req.headers.authorization)
    if (!out) { res.writeHead(404); res.end('nope'); return }
    res.writeHead(out.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, server }
}

const NONCE = new Uint8Array(randomBytes(32))
const nonceHex = Buffer.from(NONCE).toString('hex')

describe('registry', () => {
  it('lists chutes + aci and rejects unknown ids', async () => {
    expect(adapterIds()).toEqual(expect.arrayContaining(['chutes', 'aci']))
    await expect(loadAdapter('nope')).rejects.toThrow(/unknown provider adapter/)
  })
})

describe('chutes adapter', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  it('adds auth, picks an instance, decodes the b64 quote, reshapes GPU evidence', async () => {
    const quoteBytes = randomBytes(64)
    let sawAuth: string | undefined
    const stub = await startStub((url, auth) => {
      sawAuth = auth
      if (url.pathname !== '/chutes/mychute/evidence' || url.searchParams.get('nonce') !== nonceHex) return null
      return { status: 200, body: [{
        instance_id: 'i-1',
        quote: quoteBytes.toString('base64'),
        e2e_pubkey: 'cHVia2V5',
        gpu_evidence: [{ arch: 'BLACKWELL', evidence: 'ev0', certificate: 'c0' }, { arch: 'BLACKWELL', evidence: 'ev1', certificate: 'c1' }],
      }] }
    })
    server = stub.server
    const adapter = await loadAdapter('chutes')
    const ev = await adapter.fetchEvidence(NONCE, { CHUTES_API_BASE: stub.base, CHUTES_API_KEY: 'k', CHUTES_CHUTE: 'mychute' })
    expect(sawAuth).toBe('Bearer k')
    expect(Buffer.from(ev.quote).equals(quoteBytes)).toBe(true)
    expect(ev.bindingScheme).toBe('nonce-pubkey-sha256-v1')
    expect(ev.ingredients?.e2ePubkey).toBe('cHVia2V5')
    expect(ev.gpuEvidence).toEqual({ arch: 'BLACKWELL', evidence_list: [{ evidence: 'ev0', certificate: 'c0' }, { evidence: 'ev1', certificate: 'c1' }] })
  })

  it('throws when required env is missing', async () => {
    const adapter = await loadAdapter('chutes')
    await expect(adapter.fetchEvidence(NONCE, {})).rejects.toThrow(/CHUTES_API_KEY is required/)
  })
})

describe('aci adapter', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  it('fetches the nonce-bound report, hex-decodes the quote, binds aci-keyset-v1', async () => {
    const quoteBytes = randomBytes(32)
    const digest = 'c'.repeat(64)
    const stub = await startStub((url) => {
      if (url.pathname !== '/v1/aci/attestation' || url.searchParams.get('nonce') !== nonceHex) return null
      return { status: 200, body: {
        api_version: 'aci/1',
        workload_keyset_digest: `sha256:${digest}`,
        attestation: { evidence: { quote: quoteBytes.toString('hex') } },
      } }
    })
    server = stub.server
    const adapter = await loadAdapter('aci')
    const ev = await adapter.fetchEvidence(NONCE, { ACI_ATTESTATION_URL: `${stub.base}/v1/aci/attestation` })
    expect(Buffer.from(ev.quote).equals(quoteBytes)).toBe(true)
    expect(ev.bindingScheme).toBe('aci-keyset-v1')
    expect(ev.ingredients?.keysetDigest).toBe(digest)
  })

  it('throws when ACI_ATTESTATION_URL is missing', async () => {
    const adapter = await loadAdapter('aci')
    await expect(adapter.fetchEvidence(NONCE, {})).rejects.toThrow(/ACI_ATTESTATION_URL is required/)
  })
})
