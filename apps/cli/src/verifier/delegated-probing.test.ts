import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import type { AntseedNode, ConnectedDelegate, PeerInfo, ProbeJobRequestPayload, ProbeJobResultPayload } from '@antseed/node'
import { createResponseAuthPayload } from '@antseed/node'
import { generateProbeSet, probeBankSource } from '@antseed/fingerprints'
import { probeSellerViaDelegates } from './delegated-probing.js'

const SELLER_WALLET = new Wallet('0x' + '11'.repeat(32))
const SELLER_PEER = SELLER_WALLET.address.slice(2).toLowerCase()
const DELEGATE_PEER = 'd'.repeat(40)
const PAYOUT = '0x' + 'ab'.repeat(20)
const SERVICE = 'kimi-k2'

const noop = (): void => {}
const OPTIONS = { jobTimeoutMs: 5_000, log: noop, warn: noop }

function probeSet() {
  return generateProbeSet({ service: SERVICE, count: 3, seed: 'aa'.repeat(32), source: probeBankSource() })
}

function delegate(peerId = DELEGATE_PEER): ConnectedDelegate {
  return { peerId, payoutAddress: PAYOUT, maxConcurrentJobs: 1, connectedAt: 0 } as unknown as ConnectedDelegate
}

function sellerPeer(): PeerInfo {
  return { peerId: SELLER_PEER, onChainAgentId: 7 } as unknown as PeerInfo
}

/**
 * Fake delegate+seller: executes the job like an honest delegate against an
 * honest seller — signs a real ResponseAuth over the exact request/response.
 * `tamper` lets tests corrupt what the "delegate" reports back.
 */
function fakeNode(options?: {
  tamper?: (result: ProbeJobResultPayload) => ProbeJobResultPayload
  fail?: boolean
}): AntseedNode {
  return {
    async runProbeJob(delegatePeerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload> {
      if (options?.fail) {
        return { version: 1, jobId: job.jobId, status: 'error', error: 'seller unreachable' }
      }
      const body = Buffer.from(job.request.bodyBase64, 'base64')
      const model = (JSON.parse(body.toString('utf8')) as { model?: string }).model ?? job.service
      const request = {
        requestId: job.request.requestId,
        method: job.request.method,
        path: job.request.path,
        headers: job.request.headers,
        body: new Uint8Array(body),
      }
      const responseBody = new TextEncoder().encode(JSON.stringify({
        choices: [{ message: { content: 'I would guess around 42 for each of these.' } }],
      }))
      const responseHeaders = { 'content-type': 'application/json' }
      const response = {
        requestId: request.requestId,
        statusCode: 200,
        headers: responseHeaders,
        body: responseBody,
      }
      const responseAuth = createResponseAuthPayload({
        request,
        response,
        buyerPeerId: delegatePeerId,
        sellerPeerId: SELLER_PEER,
        advertisedService: model,
        provider: 'openai',
        responseStartedAt: 1,
        responseCompletedAt: 2,
      }, SELLER_WALLET)
      const result: ProbeJobResultPayload = {
        version: 1,
        jobId: job.jobId,
        status: 'ok',
        response: {
          statusCode: 200,
          headers: responseHeaders,
          bodyBase64: Buffer.from(responseBody).toString('base64'),
        },
        responseAuth,
      }
      return options?.tamper ? options.tamper(result) : result
    },
  } as unknown as AntseedNode
}

test('verified delegate observations produce an authenticated run and credit the carrier', async () => {
  const { run, jobsByPayout } = await probeSellerViaDelegates(
    fakeNode(), [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, true)
  assert.ok(run.responseAuths.length > 0)
  assert.ok(run.responseAuths.every((auth) => auth !== null))
  assert.equal(run.errors.length, 0)
  assert.equal(jobsByPayout.get(PAYOUT), run.responseAuths.length)
})

test('a tampered response body is rejected even with a genuine seller signature', async () => {
  const node = fakeNode({
    tamper: (result) => ({
      ...result,
      response: {
        ...result.response!,
        // Delegate swaps in a fabricated answer; the seller's signature no
        // longer covers this body.
        bodyBase64: Buffer.from(JSON.stringify({
          choices: [{ message: { content: 'definitely 999999' } }],
        })).toString('base64'),
      },
    }),
  })
  const { run, jobsByPayout } = await probeSellerViaDelegates(
    node, [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, false)
  assert.ok(run.responseAuths.every((auth) => auth === null))
  assert.ok(run.errors.some((e) => e.includes('invalid ResponseAuth')))
  assert.equal(jobsByPayout.size, 0)
  // No answers may be extracted from an unverified body.
  assert.ok(run.answers.every((a) => a === null))
})

test('a stripped ResponseAuth yields an unauthenticated observation, not a crash', async () => {
  const node = fakeNode({
    tamper: (result) => {
      const { responseAuth: _dropped, ...rest } = result
      return rest
    },
  })
  const { run, jobsByPayout } = await probeSellerViaDelegates(
    node, [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, false)
  assert.equal(jobsByPayout.size, 0)
})

test('delegate failures surface as errors and never credit', async () => {
  const { run, jobsByPayout } = await probeSellerViaDelegates(
    fakeNode({ fail: true }), [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, false)
  assert.ok(run.errors.some((e) => e.includes('seller unreachable')))
  assert.equal(jobsByPayout.size, 0)
})

test('requires at least one delegate', async () => {
  await assert.rejects(
    probeSellerViaDelegates(fakeNode(), [], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS),
    /no delegates/,
  )
})
