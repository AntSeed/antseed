import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BuyerPaymentManager, PeerInfo, PeerId } from '@antseed/node'
import { findAccessOffer, handleAccessBilling } from './access-billing.js'

const seller = 'c'.repeat(40) as PeerId
const serviceId = 'example-access'
const peer = (price = 0.59): PeerInfo => ({
  peerId: seller, lastSeen: Date.now(), providers: ['example'],
  providerPricing: { example: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: { [serviceId]: { inputUsdPerMillion: price, outputUsdPerMillion: 0 } } } },
  providerServiceApiProtocols: { example: { services: { [serviceId]: ['antseed-day-pass'] } } },
})

function fixture() {
  let agreement: unknown = null
  let approvals = 0
  let pauses = 0
  const buyer = {
    getAccessAgreement: () => agreement,
    getAccessPurchase: () => null,
    acceptAccessTerms: (_seller: string, _service: string, terms: unknown) => { approvals++; agreement = terms },
    pauseAccess: () => { pauses++ },
  } as unknown as BuyerPaymentManager
  const invoke = async (method: string, input?: unknown, peers = [peer()], headers: Record<string, string> = {}) => {
    const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]) as IncomingMessage
    req.method = method
    req.headers = { host: '127.0.0.1:8377', 'content-type': 'application/json', ...headers }
    req.url = `/_antseed/access-billing?serviceId=${serviceId}&sellerPeerId=${seller}`
    let status = 0
    let result: any
    const res = { writeHead: (code: number) => { status = code }, end: (body: string) => { result = JSON.parse(body) } } as ServerResponse
    await handleAccessBilling(req, res, buyer, async () => peers)
    return { status, result }
  }
  return { invoke, counts: () => ({ approvals, pauses }) }
}

test('access discovery identifies the exact seller and service and refuses ambiguity or guessed prices', () => {
  assert.deepEqual(findAccessOffer([peer()], serviceId, seller), { peerId: seller, serviceId, amountMicroUsdc: '590000', durationSeconds: 86400 })
  assert.equal(findAccessOffer([peer()], 'other-service', seller), null)
  assert.equal(findAccessOffer([peer()], serviceId, 'a'.repeat(40)), null)
  assert.equal(findAccessOffer([peer(), { ...peer(), peerId: 'a'.repeat(40) as PeerId }], serviceId), null)
  assert.equal(findAccessOffer([], serviceId), null)
  assert.equal(findAccessOffer([peer(Number.NaN)], serviceId), null)
})

test('reading a quote never activates or purchases access', async () => {
  const { invoke, counts } = fixture()
  const { result, status } = await invoke('GET')
  assert.equal(status, 200)
  assert.equal(result.offer.amountMicroUsdc, '590000')
  assert.equal(result.purchase, null)
  assert.deepEqual(counts(), { approvals: 0, pauses: 0 })
})

test('activation requires exact current terms; pausing does not need discovery', async () => {
  const { invoke, counts } = fixture()
  const input = { action: 'activate', sellerPeerId: seller, serviceId, amountMicroUsdc: '590000', durationSeconds: 86400 }
  assert.equal((await invoke('POST', { ...input, amountMicroUsdc: '500000' })).status, 409)
  assert.equal((await invoke('POST', { ...input, durationSeconds: 1 })).status, 409)
  assert.equal((await invoke('POST', input, [])).status, 503)
  assert.deepEqual(counts(), { approvals: 0, pauses: 0 })
  assert.equal((await invoke('POST', input)).status, 200)
  assert.equal((await invoke('POST', { ...input, action: 'pause' }, [])).status, 200)
  assert.deepEqual(counts(), { approvals: 1, pauses: 1 })
})

test('access control rejects malformed or oversized requests without changing permission', async () => {
  const { invoke, counts } = fixture()
  for (const input of [null, [], { action: 'activate' }, { action: 'other', sellerPeerId: seller, serviceId }]) {
    assert.equal((await invoke('POST', input)).status, 400)
  }
  assert.equal((await invoke('POST', { padding: 'x'.repeat(5000) })).status, 413)
  assert.equal((await invoke('DELETE')).status, 405)
  assert.equal((await invoke('POST', {}, [peer()], { origin: 'http://localhost.evil.example' })).status, 403)
  assert.equal((await invoke('POST', {}, [peer()], { host: 'rebound.evil.example' })).status, 403)
  assert.equal((await invoke('POST', {}, [peer()], { 'content-type': 'text/plain' })).status, 415)
  assert.deepEqual(counts(), { approvals: 0, pauses: 0 })
})
