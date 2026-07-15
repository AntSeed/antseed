import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  AntseedNode,
  DelegateCreditsAccrual,
  PeerInfo,
  ProbeJobRequestPayload,
  ProbeJobResultPayload,
} from '@antseed/node'
import { CONNECTION_CAPABILITY_PROBE_DELEGATION_V1, ConnectionState } from '@antseed/node'
import { DelegateWorker } from './worker.js'

const SELF_PEER = 'a'.repeat(40)
const VERIFIER_PEER = 'b'.repeat(40)
const TARGET_PEER = 'c'.repeat(40)
const SERVICE = 'kimi-k2'

type JobHandler = (job: ProbeJobRequestPayload) => Promise<Omit<ProbeJobResultPayload, 'version' | 'jobId'>>

function verifierPeer(): PeerInfo {
  return {
    peerId: VERIFIER_PEER,
    capabilities: [CONNECTION_CAPABILITY_PROBE_DELEGATION_V1],
  } as unknown as PeerInfo
}

function targetPeer(services: string[] = [SERVICE]): PeerInfo {
  return {
    peerId: TARGET_PEER,
    metadata: { providers: [{ provider: 'openai', services }] },
  } as unknown as PeerInfo
}

function job(overrides?: Partial<ProbeJobRequestPayload> & { model?: string }): ProbeJobRequestPayload {
  // A bounded completion budget is now mandatory (validateProbeJob), so every
  // lifecycle job carries one — these tests exercise dispatch/approval/slot
  // behavior, not the budget gate itself.
  const body = JSON.stringify({ model: overrides?.model ?? SERVICE, messages: [], max_tokens: 256 })
  return {
    version: 1,
    jobId: 'job-1',
    targetPeerId: TARGET_PEER,
    service: SERVICE,
    request: {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(body).toString('base64'),
    },
    timeoutMs: 30_000,
    ...overrides,
  }
}

interface FakeNodeOptions {
  target?: PeerInfo | null
  sendRequest?: AntseedNode['sendRequest']
}

function fakeNode(handlers: JobHandler[], options?: FakeNodeOptions): AntseedNode {
  return {
    peerId: SELF_PEER,
    getPeerConnectionState: () => ConnectionState.Authenticated,
    discoverPeers: async () => [verifierPeer()],
    serveProbeJobs: async (
      _verifier: PeerInfo,
      _hello: unknown,
      handler: JobHandler,
    ) => {
      handlers.push(handler)
      return { accepted: true }
    },
    findPeer: async () => (options?.target !== undefined ? options.target : targetPeer()),
    sendRequest: options?.sendRequest
      ?? (async () => ({
        requestId: 'req-1',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"choices":[]}'),
      })),
    getResponseAuth: () => null,
  } as unknown as AntseedNode
}

function makeWorker(node: AntseedNode, overrides?: {
  isApprovedVerifier?: (address: string) => Promise<boolean>
  approvalTtlMs?: number
  rejectedTtlMs?: number
  discoveryIntervalMs?: number
}): DelegateWorker {
  return new DelegateWorker({
    node,
    isApprovedVerifier: overrides?.isApprovedVerifier ?? (async () => true),
    ...(overrides?.approvalTtlMs !== undefined ? { approvalTtlMs: overrides.approvalTtlMs } : {}),
    ...(overrides?.rejectedTtlMs !== undefined ? { rejectedTtlMs: overrides.rejectedTtlMs } : {}),
    ...(overrides?.discoveryIntervalMs !== undefined ? { discoveryIntervalMs: overrides.discoveryIntervalMs } : {}),
    log: () => {},
    warn: () => {},
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a stopped worker fails closed even though the channel is still open', async () => {
  const handlers: JobHandler[] = []
  const worker = makeWorker(fakeNode(handlers))
  worker.start()
  await waitFor(() => handlers.length === 1)
  assert.deepEqual(worker.servingVerifiers, [VERIFIER_PEER])

  worker.stop()
  assert.deepEqual(worker.servingVerifiers, [])
  const result = await handlers[0]!(job())
  assert.equal(result.status, 'error')
  assert.equal(result.error, 'stopped')
})

test('stop() during the approval await prevents the paid request (TOCTOU)', async () => {
  const handlers: JobHandler[] = []
  let requestsSent = 0
  const node = fakeNode(handlers, {
    sendRequest: (async () => {
      requestsSent += 1
      return {
        requestId: 'req-1',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"choices":[]}'),
      }
    }) as unknown as AntseedNode['sendRequest'],
  })
  // First check (registration) resolves immediately; the job-time re-check
  // hangs until the test releases it — the window stop() lands in.
  let approvalCalls = 0
  let releaseApproval: (approved: boolean) => void = () => {}
  const gated = new Promise<boolean>((resolve) => { releaseApproval = resolve })
  const worker = makeWorker(node, {
    isApprovedVerifier: async () => (approvalCalls++ === 0 ? true : gated),
    approvalTtlMs: 0, // force the on-job re-check
  })
  worker.start()
  await waitFor(() => handlers.length === 1)

  const inFlight = handlers[0]!(job())
  await waitFor(() => approvalCalls === 2) // job is inside the approval await
  worker.stop()
  releaseApproval(true) // approval arrives AFTER stop() — must not dispatch

  const result = await inFlight
  assert.equal(result.status, 'error')
  assert.equal(result.error, 'stopped')
  assert.equal(requestsSent, 0, 'no paid request may be sent after stop()')
})

test('a revoked verifier stops getting jobs and is dropped from serving', async () => {
  const handlers: JobHandler[] = []
  let approved = true
  const worker = makeWorker(fakeNode(handlers), {
    isApprovedVerifier: async () => approved,
    approvalTtlMs: 0, // re-check on every job
  })
  worker.start()
  await waitFor(() => handlers.length === 1)

  // Approved: the job reaches execution (target found, request relayed).
  const okResult = await handlers[0]!(job())
  assert.equal(okResult.status, 'ok')

  // Revoke on-chain: the next job must be refused and the registration dropped.
  approved = false
  const revokedResult = await handlers[0]!(job())
  assert.equal(revokedResult.status, 'error')
  assert.equal(revokedResult.error, 'verifier_not_approved')
  assert.deepEqual(worker.servingVerifiers, [])

  worker.stop()
})

test('an expired approval rejects paid jobs when the RPC is unavailable', async () => {
  const handlers: JobHandler[] = []
  let requestsSent = 0
  let approvalCalls = 0
  const node = fakeNode(handlers, {
    sendRequest: (async () => {
      requestsSent += 1
      throw new Error('must not dispatch')
    }) as unknown as AntseedNode['sendRequest'],
  })
  const worker = makeWorker(node, {
    isApprovedVerifier: async () => {
      approvalCalls += 1
      if (approvalCalls === 1) return true
      throw new Error('rpc unavailable')
    },
    approvalTtlMs: 5,
    discoveryIntervalMs: 60_000,
  })
  try {
    worker.start()
    await waitFor(() => handlers.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const result = await handlers[0]!(job())
    assert.equal(result.status, 'error')
    assert.equal(result.error, 'verifier_not_approved')
    assert.equal(requestsSent, 0)
  } finally {
    worker.stop()
  }
})

test('job timeout aborts the in-flight request and releases the concurrency slot', async () => {
  const handlers: JobHandler[] = []
  const node = fakeNode(handlers, {
    // Hangs forever unless the abort signal fires — like an abandoned seller.
    sendRequest: (async (_peer: unknown, _req: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as AntseedNode['sendRequest'],
  })
  const worker = makeWorker(node)
  worker.start()
  await waitFor(() => handlers.length === 1)

  const started = Date.now()
  const result = await handlers[0]!(job({ timeoutMs: 50 }))
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /request_failed: aborted/)
  assert.ok(Date.now() - started < 5_000, 'job must not run to completion')

  // The slot was released: an immediate follow-up job is not "busy".
  const followUp = await handlers[0]!(job({ timeoutMs: 60_000, jobId: 'job-2' }))
  assert.notEqual(followUp.error, 'busy')

  worker.stop()
})

test('stop() aborts in-flight jobs', async () => {
  const handlers: JobHandler[] = []
  const node = fakeNode(handlers, {
    sendRequest: (async (_peer: unknown, _req: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as AntseedNode['sendRequest'],
  })
  const worker = makeWorker(node)
  worker.start()
  await waitFor(() => handlers.length === 1)

  const inFlight = handlers[0]!(job({ timeoutMs: 60_000 }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  worker.stop()
  const result = await inFlight
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /request_failed: aborted/)
})

test('a transient rejection expires instead of blacklisting the verifier until restart', async () => {
  const handlers: JobHandler[] = []
  let approved = false
  const worker = makeWorker(fakeNode(handlers), {
    isApprovedVerifier: async () => approved,
    approvalTtlMs: 0,
    rejectedTtlMs: 200,
    discoveryIntervalMs: 20,
  })
  try {
    // First scan: rejected (not approved on-chain).
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(worker.servingVerifiers, [])

    // Approval lands on-chain. While the rejection TTL holds, repeated scans
    // must still skip the verifier…
    approved = true
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(worker.servingVerifiers, [])

    // …but once it expires, a later scan re-evaluates and serves it.
    await waitFor(() => worker.servingVerifiers.length === 1)
    assert.deepEqual(worker.servingVerifiers, [VERIFIER_PEER])
  } finally {
    worker.stop()
  }
})

test('discovers on-chain credit accruals for its own buyer and records them from the persisted cursor', async () => {
  const handlers: JobHandler[] = []
  const node = fakeNode(handlers)
  const scans: Array<{ buyer: string; fromBlock: number }> = []
  const recorded: DelegateCreditsAccrual[] = []
  let cursor = 0
  const accrual: DelegateCreditsAccrual = {
    verifier: 'v'.repeat(40),
    probeCommitment: '0x' + 'ab'.repeat(32),
    buyer: SELF_PEER,
    credits: 4,
    blockNumber: 500,
  }
  const worker = new DelegateWorker({
    node,
    isApprovedVerifier: async () => true,
    discoveryIntervalMs: 20,
    creditStore: {
      getCursor: async () => cursor,
      recordScan: async (accruals, toBlock) => {
        recorded.push(...accruals)
        cursor = toBlock
        return accruals.length
      },
    },
    discoverAccruals: async (buyer, fromBlock) => {
      scans.push({ buyer, fromBlock })
      if (fromBlock <= 500) return { accruals: [accrual], toBlock: 500 }
      if (fromBlock <= 550) return { accruals: [], toBlock: 550 }
      return { accruals: [], toBlock: fromBlock }
    },
    log: () => {},
    warn: () => {},
  })
  try {
    worker.start()
    await waitFor(() => recorded.length === 1)
    assert.equal(recorded[0]!.probeCommitment, accrual.probeCommitment)
    // The scan is filtered by this node's own buyer address and resumes from
    // the block after the persisted cursor (1 on the first pass, then 501).
    assert.equal(scans[0]!.buyer.toLowerCase(), ('0x' + SELF_PEER).toLowerCase())
    assert.equal(scans[0]!.fromBlock, 1)
    await waitFor(() => scans.length >= 3)
    assert.equal(scans[1]!.fromBlock, 501)
    assert.equal(scans[2]!.fromBlock, 551)
  } finally {
    worker.stop()
  }
})

test('jobs targeting a seller that does not advertise the service are refused', async () => {
  const handlers: JobHandler[] = []
  const worker = makeWorker(fakeNode(handlers, { target: targetPeer(['other-model']) }))
  worker.start()
  await waitFor(() => handlers.length === 1)

  const result = await handlers[0]!(job())
  assert.equal(result.status, 'error')
  assert.equal(result.error, 'target_does_not_serve_service')
  worker.stop()
})
