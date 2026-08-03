import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  AntseedNode,
  AuditRelayJobPayload,
  PeerInfo,
  RelayJobValidator,
  StoredRelayEntitlement,
} from '@antseed/node'
import {
  createResponseAuthPayload,
  encodeHttpRequest,
  hashRequest,
  identityFromPrivateKeyHex,
} from '@antseed/node'
import { serviceHash } from '@antseed/node/payments'
import { RelayWorker, validateRelayRequest } from './worker.js'

const SERVICE = 'gpt-test'

function fixture() {
  const relay = identityFromPrivateKeyHex('11'.repeat(32))
  const verifier = identityFromPrivateKeyHex('22'.repeat(32))
  const seller = identityFromPrivateKeyHex('33'.repeat(32))
  const nowMs = Date.now()
  const request = {
    requestId: 'audit-request-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: SERVICE,
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0,
      max_tokens: 100,
      n: 1,
    })),
  } as const
  const response = {
    requestId: request.requestId,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      choices: [{ message: { content: '(1) 1' } }],
    })),
  }
  const executeAfter = Math.floor(nowMs / 1_000) - 1
  const executeBefore = executeAfter + 120
  const responseAuth = createResponseAuthPayload({
    request,
    response,
    buyerPeerId: relay.peerId,
    sellerPeerId: seller.peerId,
    advertisedService: SERVICE,
    provider: 'openai',
    responseStartedAt: nowMs,
    responseCompletedAt: nowMs + 25,
    channelId: `0x${'ab'.repeat(32)}`,
  }, seller.wallet)
  const offer: AuditRelayJobPayload = {
    version: 1,
    jobId: 'job-1',
    chainId: 'base-local',
    registryAddress: `0x${'44'.repeat(20)}`,
    treasuryAddress: `0x${'55'.repeat(20)}`,
    auditSnapshot: {
      committer: verifier.wallet.address,
      auditJobRoot: `0x${'66'.repeat(32)}`,
      jobCount: 10,
      payoutPerJobUsdc: '1000',
      reservedRelayBudgetUsdc: '10000',
      executeAfter,
      executeBefore,
      forceClaimAvailableAt: executeBefore + 6 * 60 * 60,
      forceClaimDeadline: executeBefore + 24 * 60 * 60,
      attested: false,
    },
    job: {
      auditId: `0x${'77'.repeat(32)}`,
      jobIndex: 0,
      sellerPeerId: seller.wallet.address,
      serviceHash: serviceHash(SERVICE),
      requestHash: hashRequest(request),
      jobSalt: `0x${'88'.repeat(32)}`,
      executeAfter,
      executeBefore,
    },
    jobProof: [`0x${'99'.repeat(32)}`],
    assignment: {
      auditId: `0x${'77'.repeat(32)}`,
      jobIndex: 0,
      attempt: 0,
      relayBuyer: relay.wallet.address,
      payoutPerJobUsdc: '1000',
      executeAfter,
      executeBefore,
    },
    verifierSignature: `0x${'aa'.repeat(65)}`,
    targetPeerId: seller.peerId,
    service: SERVICE,
    requestBytesBase64: Buffer.from(encodeHttpRequest(request)).toString('base64'),
    payoutPerJobUsdc: '1000',
    timeoutMs: 5_000,
  }
  const verifierPeer: PeerInfo = {
    peerId: verifier.peerId,
    lastSeen: nowMs,
    providers: [],
  }
  const sellerPeer: PeerInfo = {
    peerId: seller.peerId,
    lastSeen: nowMs,
    providers: ['openai'],
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        services: { [SERVICE]: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
      },
    },
  }
  const authRecord = {
    ...responseAuth,
    receivedAt: nowMs + 30,
    verified: true,
    verificationError: null,
  }
  return { relay, verifierPeer, sellerPeer, request, response, offer, authRecord }
}

function workerFixture(options: {
  value?: ReturnType<typeof fixture>
  existing?: StoredRelayEntitlement | null
  persist?: (entitlement: StoredRelayEntitlement) => void
  sendRequest?: () => Promise<ReturnType<typeof fixture>['response']>
} = {}) {
  const value = options.value ?? fixture()
  const persisted: StoredRelayEntitlement[] = []
  const node = {
    peerId: value.relay.peerId,
    findPeer: async () => value.sellerPeer,
    sendRequest: options.sendRequest ?? (async () => value.response),
    waitForResponseAuth: async () => value.authRecord,
    finalizeResponsePayment: async () => ({
      sellerChargeUsdc: 400n,
      spendingAuth: { channelId: `0x${'aa'.repeat(32)}`, cumulativeAmount: '400' },
    }),
  } as unknown as AntseedNode
  const validator = {
    validate: async () => ({ request: value.request, job: value.offer.job }),
  } as unknown as RelayJobValidator
  const worker = new RelayWorker({
    node,
    validator,
    storage: {
      getRelayEntitlement: () => options.existing ?? null,
      listRelayEntitlements: () => [],
      persistRelayEntitlement: (entitlement) => {
        options.persist?.(entitlement)
        persisted.push(entitlement)
      },
      persistRelaySuccess: () => {},
      updateRelayEntitlementState: () => {},
    },
    chainId: value.offer.chainId,
    registryAddress: value.offer.registryAddress,
    treasuryAddress: value.offer.treasuryAddress,
    relayBuyerAddress: value.relay.wallet.address,
    minimumPayoutPerJobUsdc: 100n,
    isApprovedVerifier: async () => true,
    log: () => {},
    warn: () => {},
  })
  return { ...value, worker, persisted }
}

test('validateRelayRequest accepts the canonical non-streaming audit request', () => {
  const { offer, relay } = fixture()
  assert.equal(validateRelayRequest(offer, relay.peerId), null)
})

test('validateRelayRequest rejects non-canonical body fields and multiple completions', () => {
  const { offer, request, relay } = fixture()
  const rewrite = (body: Record<string, unknown>): AuditRelayJobPayload => ({
    ...offer,
    requestBytesBase64: Buffer.from(encodeHttpRequest({
      ...request,
      body: new TextEncoder().encode(JSON.stringify(body)),
    })).toString('base64'),
  })
  assert.match(validateRelayRequest(rewrite({ model: SERVICE, messages: [], max_tokens: 1, tools: [] }), relay.peerId) ?? '', /disallowed_body_field/)
  assert.equal(validateRelayRequest(rewrite({ model: SERVICE, messages: [], max_tokens: 1, n: 2 }), relay.peerId), 'n_out_of_bounds')
})

test('RelayWorker persists the complete entitlement before returning the result', async () => {
  let persistedBeforeReturn = false
  const { worker, verifierPeer, offer, persisted } = workerFixture({
    persist: () => { persistedBeforeReturn = true },
  })
  const result = await worker.executeOffer(verifierPeer, offer)
  assert.equal(result.status, 'ok')
  assert.equal(persistedBeforeReturn, true)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0]?.state, 'awaiting-attestation')
  assert.equal(persisted[0]?.sellerChargeUsdc, 400n)
  assert.equal(persisted[0]?.payoutUsdc, 1000n)
  assert.ok(result.responseAuthPayloadBase64)
})

test('RelayWorker returns the cached result for duplicate delivery of the same signed assignment', async () => {
  const first = workerFixture()
  await first.worker.executeOffer(first.verifierPeer, first.offer)
  const existing = first.persisted[0]!
  const { worker, verifierPeer, offer, persisted } = workerFixture({ existing, value: first })
  const result = await worker.executeOffer(verifierPeer, offer)
  assert.equal(result.status, 'ok')
  assert.equal(result.responseBytesBase64, Buffer.from(existing.responseBytes).toString('base64'))
  assert.equal(persisted.length, 0)
})

test('RelayWorker coalesces duplicate delivery while the signed assignment is still executing', async () => {
  let release!: () => void
  let requestCount = 0
  const gate = new Promise<void>((resolve) => { release = resolve })
  const value = fixture()
  const { worker, verifierPeer, offer, persisted } = workerFixture({
    sendRequest: async () => {
      requestCount += 1
      await gate
      return value.response
    },
  })

  const first = worker.executeOffer(verifierPeer, offer)
  const duplicate = worker.executeOffer(verifierPeer, offer)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requestCount, 1)
  release()

  const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
  assert.deepEqual(duplicateResult, firstResult)
  assert.equal(persisted.length, 1)
})

test('RelayWorker returns an error instead of exposing a result when entitlement persistence fails', async () => {
  const { worker, verifierPeer, offer } = workerFixture({
    persist: () => { throw new Error('durable write failed') },
  })
  const result = await worker.executeOffer(verifierPeer, offer)
  assert.deepEqual(result, { status: 'error', error: 'durable write failed' })
})
