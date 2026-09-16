import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BuyerPaymentManager, PeerInfo } from '@antseed/node'
import { buildNetworkServiceOffers } from '@antseed/node/discovery'

export interface AccessOffer {
  peerId: string
  serviceId: string
  amountMicroUsdc: string
  durationSeconds: number
}

export function findAccessOffer(peers: PeerInfo[], serviceId: string, sellerPeerId?: string): AccessOffer | null {
  const offers = buildNetworkServiceOffers(peers).filter((offer) => offer.type === 'day-pass'
    && offer.serviceId === serviceId && (!sellerPeerId || offer.peerId === sellerPeerId))
  if (offers.length !== 1) return null
  const offer = offers[0]!
  const price = offer.flatUsdPrice
  if (price === undefined || !Number.isFinite(price) || price < 0) return null
  const amount = Math.round(price * 1_000_000)
  if (!Number.isSafeInteger(amount)) return null
  return { peerId: offer.peerId, serviceId, amountMicroUsdc: String(amount), durationSeconds: 86_400 }
}

export async function handleAccessBilling(
  req: IncomingMessage,
  res: ServerResponse,
  buyer: BuyerPaymentManager | null,
  findPeers: () => Promise<PeerInfo[]>,
): Promise<void> {
  const reply = (status: number, data: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (req.headers.origin !== undefined || !/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(req.headers.host ?? '')) {
    return reply(403, { ok: false, error: 'Access approvals require the local CLI or desktop application' })
  }
  if (req.method === 'POST' && req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    return reply(415, { ok: false, error: 'Expected application/json' })
  }
  if (!buyer) return reply(503, { ok: false, error: 'Payments are not configured' })
  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const serviceId = url.searchParams.get('serviceId') ?? ''
    const seller = url.searchParams.get('sellerPeerId')?.replace(/^0x/i, '').toLowerCase()
    const offer = findAccessOffer(await findPeers(), serviceId, seller)
    const peerId = seller ?? offer?.peerId
    return reply(200, { ok: true, offer,
      agreement: peerId ? buyer.getAccessAgreement(peerId, serviceId) : null,
      purchase: peerId ? buyer.getAccessPurchase(peerId, serviceId) : null })
  }
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 4096) return reply(413, { ok: false, error: 'Request too large' })
    chunks.push(Buffer.from(chunk))
  }
  let input: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    input = parsed as Record<string, unknown>
  } catch {
    return reply(400, { ok: false, error: 'Invalid JSON object' })
  }
  const seller = typeof input.sellerPeerId === 'string' ? input.sellerPeerId.replace(/^0x/i, '').toLowerCase() : ''
  const serviceId = typeof input.serviceId === 'string' ? input.serviceId : ''
  if (!/^[0-9a-f]{40}$/.test(seller) || !serviceId || serviceId.length > 256) return reply(400, { ok: false, error: 'Invalid seller or service' })
  if (input.action === 'pause') {
    buyer.pauseAccess(seller, serviceId)
    return reply(200, { ok: true })
  }
  if (input.action !== 'activate') return reply(400, { ok: false, error: 'Expected activate or pause' })
  const offer = findAccessOffer(await findPeers(), serviceId, seller)
  if (!offer) return reply(503, { ok: false, error: 'PRICING_UNAVAILABLE' })
  if (input.amountMicroUsdc !== offer.amountMicroUsdc || input.durationSeconds !== offer.durationSeconds) {
    return reply(409, { ok: false, error: 'BILLING_TERMS_CHANGED: refresh the offer before activating' })
  }
  buyer.acceptAccessTerms(seller, serviceId, offer)
  return reply(200, { ok: true, agreement: buyer.getAccessAgreement(seller, serviceId) })
}
