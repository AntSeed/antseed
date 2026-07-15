import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import type { AntseedNode, ConnectedDelegate, PeerInfo, ProbeJobRequestPayload, ProbeJobResultPayload } from '@antseed/node'
import { createResponseAuthPayload } from '@antseed/node'
import { generateProbeSet, probeBankSource } from '@antseed/fingerprints'
import { assignPrimaryCarriers, makeNodeTargetQuerier, probeSellerViaDelegates, solicitDelegateTargets } from './delegated-probing.js'
import { validateProbeJob } from '../delegate/worker.js'

const SELLER_WALLET = new Wallet('0x' + '11'.repeat(32))
const SELLER_PEER = SELLER_WALLET.address.slice(2).toLowerCase()
const DELEGATE_PEER = 'd'.repeat(40)
const SERVICE = 'kimi-k2'

const noop = (): void => {}
const OPTIONS = { jobTimeoutMs: 5_000, log: noop, warn: noop }

function probeSet() {
  return generateProbeSet({ service: SERVICE, count: 3, seed: 'aa'.repeat(32), source: probeBankSource() })
}

function delegate(peerId = DELEGATE_PEER): ConnectedDelegate {
  return { peerId, maxConcurrentJobs: 1, connectedAt: 0 } as unknown as ConnectedDelegate
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
  const { run, jobsByDelegate } = await probeSellerViaDelegates(
    fakeNode(), [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, true)
  assert.ok(run.responseAuths.length > 0)
  assert.ok(run.responseAuths.every((auth) => auth !== null))
  assert.equal(run.errors.length, 0)
  assert.equal(jobsByDelegate.get(DELEGATE_PEER), run.responseAuths.length)
})

test('relayed probe bodies carry a bounded completion budget the delegate worker accepts', async () => {
  // The stealth builder omits max_tokens (organic clients do), but a delegate
  // refuses an unbounded relay. The verifier must stamp a bounded budget so
  // legitimate probes are accepted rather than rejected as missing.
  const seenBodies: string[] = []
  const base = fakeNode() as unknown as {
    runProbeJob(peerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload>
  }
  const capturingNode = {
    async runProbeJob(delegatePeerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload> {
      seenBodies.push(job.request.bodyBase64)
      return base.runProbeJob(delegatePeerId, job)
    },
  } as unknown as AntseedNode

  await probeSellerViaDelegates(capturingNode, [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS)

  assert.ok(seenBodies.length > 0)
  for (const bodyBase64 of seenBodies) {
    const parsed = JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8')) as { max_tokens?: unknown }
    assert.equal(typeof parsed.max_tokens, 'number', 'relayed probe must carry a max_tokens')
    assert.ok((parsed.max_tokens as number) >= 1 && (parsed.max_tokens as number) <= 4096)
    // The exact bytes the delegate worker would validate must be accepted.
    const err = validateProbeJob({
      version: 1,
      jobId: 'j',
      targetPeerId: SELLER_PEER,
      service: SERVICE,
      request: {
        requestId: 'r',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        bodyBase64,
      },
      timeoutMs: 5_000,
    }, DELEGATE_PEER)
    assert.equal(err, null, `delegate worker must accept the relayed probe (got ${err})`)
  }
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
  const { run, jobsByDelegate } = await probeSellerViaDelegates(
    node, [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, false)
  assert.ok(run.responseAuths.every((auth) => auth === null))
  assert.ok(run.errors.some((e) => e.includes('invalid ResponseAuth')))
  assert.equal(jobsByDelegate.size, 0)
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
  const { run, jobsByDelegate } = await probeSellerViaDelegates(
    node, [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, false)
  assert.equal(jobsByDelegate.size, 0)
})

test('delegate failures surface as errors and never credit', async () => {
  const { run, jobsByDelegate } = await probeSellerViaDelegates(
    fakeNode({ fail: true }), [delegate()], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS,
  )
  assert.equal(run.fullyAuthenticated, false)
  assert.ok(run.errors.some((e) => e.includes('seller unreachable')))
  assert.equal(jobsByDelegate.size, 0)
})

test('requires at least one delegate', async () => {
  await assert.rejects(
    probeSellerViaDelegates(fakeNode(), [], sellerPeer(), SERVICE, probeSet(), 3, OPTIONS),
    /no delegates/,
  )
})

// ---------------------------------------------------------------------------
// Target solicitation: TargetQuery fan-out + organic-pair preference
// ---------------------------------------------------------------------------

test('solicitDelegateTargets fans out with allSettled: one delegate suggesting, one failing, one timing out', async () => {
  const delegates = [delegate('a'.repeat(40)), delegate('b'.repeat(40)), delegate('c'.repeat(40))]
  const warned: string[] = []
  const suggestions = await solicitDelegateTargets(
    delegates,
    SERVICE,
    async (delegatePeerId, _service, timeoutMs) => {
      if (delegatePeerId === delegates[0]!.peerId) return [{ peerId: SELLER_PEER, agentId: 7 }]
      if (delegatePeerId === delegates[1]!.peerId) throw new Error('delegate exploded')
      // The querier itself enforces the timeout (DelegationMux.runTargetQuery):
      // a silent delegate surfaces as the callee's own timeout rejection.
      throw new Error(`TargetQuery timed out after ${timeoutMs}ms`)
    },
    { timeoutMs: 50, log: noop, warn: (m) => { warned.push(m) } },
  )
  assert.deepEqual(suggestions.get(SELLER_PEER), [delegates[0]!.peerId])
  assert.equal(warned.length, 2, 'the failing and the timed-out delegate are each warned about')
  assert.ok(warned.some((m) => m.includes('delegate exploded')))
  assert.ok(warned.some((m) => m.includes('timed out')))
})

test('solicitDelegateTargets aggregates multiple suggesting delegates per seller and ignores malformed entries', async () => {
  const delegates = [delegate('a'.repeat(40)), delegate('b'.repeat(40))]
  const suggestions = await solicitDelegateTargets(
    delegates,
    SERVICE,
    async () => [
      { peerId: SELLER_PEER.toUpperCase(), agentId: 7 },
      { peerId: '', agentId: 3 } as { peerId: string; agentId: number },
    ],
    { timeoutMs: 50, log: noop, warn: noop },
  )
  assert.deepEqual(suggestions.get(SELLER_PEER), [delegates[0]!.peerId, delegates[1]!.peerId])
  assert.equal(suggestions.size, 1, 'the empty peerId entry is dropped')
})

test('a suggested delegate is PREFERRED but never the sole carrier — some probes ride a non-suggesting delegate', async () => {
  const carriers: string[] = []
  const base = fakeNode() as unknown as {
    runProbeJob(peerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload>
  }
  const capturingNode = {
    async runProbeJob(delegatePeerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload> {
      carriers.push(delegatePeerId)
      return base.runProbeJob(delegatePeerId, job)
    },
  } as unknown as AntseedNode

  const suggesting = delegate('e'.repeat(40))
  const other = delegate('f'.repeat(40))
  // Many single-probe plans so the assignment is observable.
  const set = generateProbeSet({ service: SERVICE, count: 6, seed: 'ee'.repeat(32), source: probeBankSource() })
  const { run, jobsByDelegate } = await probeSellerViaDelegates(
    capturingNode, [suggesting, other], sellerPeer(), SERVICE, set, 1,
    { ...OPTIONS, preferredDelegatePeerIds: [suggesting.peerId] },
  )
  assert.equal(run.fullyAuthenticated, true)
  const suggestingJobs = jobsByDelegate.get(suggesting.peerId) ?? 0
  const otherJobs = jobsByDelegate.get(other.peerId) ?? 0
  // A colluding lone accomplice must NOT be able to carry every probe.
  assert.ok(otherJobs >= 1, `a non-suggesting delegate must carry ≥1 probe, got ${otherJobs}`)
  // …but the suggested (organic) delegate still carries the majority for stealth.
  assert.ok(suggestingJobs > otherJobs, `the suggested delegate should carry the majority, got ${suggestingJobs} vs ${otherJobs}`)
  assert.ok(run.carrierCount !== undefined && run.carrierCount >= 2, 'carrierCount reflects both carriers')
})

test('a failing preferred delegate falls back to the ordinary rotation for the retry', async () => {
  const carriers: string[] = []
  const suggesting = delegate('e'.repeat(40))
  const other = delegate('f'.repeat(40))
  const honest = fakeNode() as unknown as {
    runProbeJob(peerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload>
  }
  const flakyNode = {
    async runProbeJob(delegatePeerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload> {
      carriers.push(delegatePeerId)
      if (delegatePeerId === suggesting.peerId) {
        return { version: 1, jobId: job.jobId, status: 'error', error: 'preferred delegate offline' }
      }
      return honest.runProbeJob(delegatePeerId, job)
    },
  } as unknown as AntseedNode

  const { run, jobsByDelegate } = await probeSellerViaDelegates(
    flakyNode, [suggesting, other], sellerPeer(), SERVICE, probeSet(), 3,
    { ...OPTIONS, preferredDelegatePeerIds: [suggesting.peerId] },
  )
  assert.equal(run.fullyAuthenticated, true, 'the retry carrier completes the run')
  assert.ok(carriers.includes(other.peerId), 'the non-preferred delegate carries the retry')
  assert.ok(!jobsByDelegate.has(suggesting.peerId), 'failed attempts earn no credit')
  assert.ok((jobsByDelegate.get(other.peerId) ?? 0) > 0)
})

test('unsuggested sellers keep the existing rotation across all delegates', async () => {
  const carriers: string[] = []
  const base = fakeNode() as unknown as {
    runProbeJob(peerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload>
  }
  const capturingNode = {
    async runProbeJob(delegatePeerId: string, job: Omit<ProbeJobRequestPayload, 'version'>): Promise<ProbeJobResultPayload> {
      carriers.push(delegatePeerId)
      return base.runProbeJob(delegatePeerId, job)
    },
  } as unknown as AntseedNode

  const a = delegate('a'.repeat(40))
  const b = delegate('b'.repeat(40))
  // 4 probes at 1 per request → 4 plans → rotation must alternate carriers.
  const set = generateProbeSet({ service: SERVICE, count: 4, seed: 'bb'.repeat(32), source: probeBankSource() })
  await probeSellerViaDelegates(capturingNode, [a, b], sellerPeer(), SERVICE, set, 1, OPTIONS)
  assert.ok(carriers.includes(a.peerId))
  assert.ok(carriers.includes(b.peerId))
})

test('makeNodeTargetQuerier adapts the node TargetQuery API and filters malformed sellers', async () => {
  const seen: Array<{ delegatePeerId: string; service: string; timeoutMs?: number }> = []
  const capable = {
    async queryDelegateTargets(delegatePeerId: string, query: { queryId: string; service: string }, timeoutMs?: number) {
      seen.push({ delegatePeerId, service: query.service, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
      assert.ok(query.queryId.length > 0)
      return { sellers: [{ peerId: SELLER_PEER, agentId: 7 }, { peerId: '', agentId: 1 }] }
    },
  } as unknown as AntseedNode
  const querier = makeNodeTargetQuerier(capable)
  const sellers = await querier('d'.repeat(40), SERVICE, 1234)
  assert.deepEqual(sellers, [{ peerId: SELLER_PEER, agentId: 7 }])
  assert.equal(seen[0]!.timeoutMs, 1234)
})

// ---------------------------------------------------------------------------
// assignPrimaryCarriers (HIGH-2): suggestions PREFER but never MONOPOLIZE
// ---------------------------------------------------------------------------

test('assignPrimaryCarriers: with both pools, the suggested pool gets the majority but a non-suggesting delegate always gets ≥1', () => {
  const pref = [delegate('a'.repeat(40))]
  const other = [delegate('b'.repeat(40))]
  for (const planCount of [1, 2, 3, 6, 24]) {
    const carriers = assignPrimaryCarriers(planCount, pref, other, [...pref, ...other])
    assert.equal(carriers.length, planCount)
    const otherCount = carriers.filter((c) => c.peerId === other[0]!.peerId).length
    assert.ok(otherCount >= 1, `planCount ${planCount}: a non-suggesting delegate must carry ≥1 (got ${otherCount})`)
    if (planCount >= 2) {
      const prefCount = planCount - otherCount
      assert.ok(prefCount >= otherCount, `planCount ${planCount}: suggested pool should keep the majority (${prefCount} vs ${otherCount})`)
    }
  }
})

test('assignPrimaryCarriers: with no suggestions it round-robins the full roster; with only suggestions it round-robins those', () => {
  const a = delegate('a'.repeat(40))
  const b = delegate('b'.repeat(40))
  // No preferred pool → rotate all.
  const none = assignPrimaryCarriers(4, [], [a, b], [a, b])
  assert.deepEqual(none.map((c) => c.peerId), [a.peerId, b.peerId, a.peerId, b.peerId])
  // No non-suggesting pool (everyone suggested) → rotate the preferred pool.
  const allPref = assignPrimaryCarriers(3, [a, b], [], [a, b])
  assert.deepEqual(allPref.map((c) => c.peerId), [a.peerId, b.peerId, a.peerId])
})
