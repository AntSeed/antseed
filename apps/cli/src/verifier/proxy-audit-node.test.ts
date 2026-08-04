import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import {
  BUYER_AUDIT_EXECUTE_PATH,
  BUYER_AUDIT_IDENTITY_PATH,
  encodeSerializedHttpResponse,
} from '../proxy/audit-protocol.js'
import { ProxyDirectAuditNode } from './proxy-audit-node.js'

const TOKEN = 'test-token'
const BUYER_PEER_ID = 'b'.repeat(40)
const TARGET_PEER_ID = 'a'.repeat(40)
const BUYER_ADDRESS = '0x1111111111111111111111111111111111111111'

test('proxy audit node replays canonical response auth and actual payment evidence', async (t) => {
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
      return
    }
    if (req.url === BUYER_AUDIT_IDENTITY_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        identity: { address: BUYER_ADDRESS, peerId: BUYER_PEER_ID },
      }))
      return
    }
    if (req.url === BUYER_AUDIT_EXECUTE_PATH) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const response = {
        requestId: input.request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '1' } }] })),
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        identity: { address: BUYER_ADDRESS, peerId: BUYER_PEER_ID },
        peerId: input.peerId,
        response: encodeSerializedHttpResponse(response),
        responseAuth: {
          version: 1,
          requestId: input.request.requestId,
          buyerPeerId: BUYER_PEER_ID,
          sellerPeerId: input.peerId,
          advertisedService: 'gpt-5.6-sol',
          provider: 'openai',
          statusCode: 200,
          requestHash: '0xrequest',
          responseHash: '0xresponse',
          responseStartedAt: 1,
          responseCompletedAt: 2,
          signature: '0xsig',
          receivedAt: 3,
          verified: true,
          verificationError: null,
        },
        payment: {
          sellerChargeUsdc: '42',
          spendingAuth: {
            channelId: '0xchannel',
            cumulativeAmount: '42',
            metadataHash: `0x${'11'.repeat(32)}`,
            metadata: '0x',
            spendingAuthSig: '0xsig',
          },
        },
        failure: null,
      }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const node = await ProxyDirectAuditNode.connect({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: TOKEN,
  })
  const peer = { peerId: TARGET_PEER_ID } as PeerInfo
  const request: SerializedHttpRequest = {
    requestId: 'request-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('{}'),
  }

  const response = await node.sendRequest(peer, request)
  const responseAuth = await node.waitForResponseAuth(request.requestId)
  const payment = await node.finalizeResponsePayment(peer, request.requestId)
  assert.equal(node.identity.address, BUYER_ADDRESS)
  assert.equal(response.statusCode, 200)
  assert.equal(responseAuth.buyerPeerId, BUYER_PEER_ID)
  assert.equal(payment.sellerChargeUsdc, 42n)
})

test('proxy audit node rejects non-local transport URLs', async () => {
  await assert.rejects(
    ProxyDirectAuditNode.connect({ baseUrl: 'https://example.com', token: TOKEN }),
    /only supports localhost HTTP URLs/,
  )
})
