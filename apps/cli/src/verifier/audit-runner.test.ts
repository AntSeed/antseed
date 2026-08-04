import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
  VerificationStorage,
  hashRequest,
  hashResponse,
  type PeerInfo,
  type StoredResponseAuth,
  type VerifierRegistryClient,
} from '@antseed/node'
import {
  attestCompletedDirectAudit,
  buildDirectAuditRequestBody,
  executeDirectAuditObservation,
  runDirectAudit,
  type DirectAuditContext,
  type DirectAuditNode,
} from './audit-runner.js'
import {
  verifyDirectAuditEvidenceFile,
  writeDirectAuditEvidence,
} from './direct-evidence.js'

const NOW = 1_800_000_100_000
const SERVICE = 'gpt-test'
const VERIFIER_ADDRESS = `0x${'11'.repeat(20)}`
const VERIFIER_PEER_ID = '11'.repeat(20)
const SELLER_PEER_ID = '22'.repeat(20)
const TX_HASH = `0x${'33'.repeat(32)}`

type NodeBehavior = 'success' | 'mismatch' | 'malformed' | 'timeout' | 'unauthenticated' | 'payment-failure'

test('direct audit requests preserve the frozen reference query profile', () => {
  const input = reference()
  input.queryProfile = {
    ...input.queryProfile,
    maxTokensPerRequest: 1600,
    generationSettings: {
      ...input.queryProfile.generationSettings,
      topP: 1,
    },
    requestOverrides: { reasoning_effort: 'none' },
  }
  const body = buildDirectAuditRequestBody(input, SERVICE, input.probes)
  assert.equal(body.max_tokens, 1600)
  assert.equal(body.top_p, 1)
  assert.equal(body.stream, false)
  assert.equal(body.n, 1)
  assert.equal(body.reasoning_effort, 'none')
})

interface Harness {
  dir: string
  storage: VerificationStorage
  context: DirectAuditContext
  target: PeerInfo
  submissions: Array<Record<string, unknown>>
  publications: Array<{ auditId: string; evidenceUri: string }>
  warnings: string[]
  close(): void
}

function reference(probeCount = 10): KbfReferenceV1 {
  const probes = Array.from({ length: probeCount }, (_unused, index) => ({
    id: `probe-${String(index).padStart(3, '0')}`,
    name: `probe-${index}`,
    domain: 'test',
    template: `Probe ${index} is ___.`,
    consensus: index,
    range: [0, 1_000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
    advisoryConsensus: false,
  }))
  return {
    version: 1,
    kind: 'kbf',
    referenceId: `reference-${probeCount}`,
    referenceModel: SERVICE,
    serviceAliases: [SERVICE],
    createdAt: '2026-08-03T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: createReferenceQueryProfile({ upstreamModel: SERVICE }),
    selfTest: {
      hamming: 0,
      total: probes.length,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: probes.length,
    minimumMismatchDelta: 0.1,
    statisticalPower: 0.99,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: probes.length,
      p0UpperBound: 0.1,
      alternativeMismatchRate: 0.2,
      criticalMismatchCount: 3,
      power: 0.99,
    },
    contrasts: [],
  }
}

function target(): PeerInfo {
  return {
    peerId: SELLER_PEER_ID as PeerInfo['peerId'],
    lastSeen: NOW,
    providers: ['test'],
    onChainAgentId: 7,
    onChainSellerAddress: `0x${SELLER_PEER_ID}`,
  }
}

function spendingAuth(): {
  channelId: string
  cumulativeAmount: string
  metadataHash: string
  metadata: string
  spendingAuthSig: string
} {
  return {
    channelId: `0x${'44'.repeat(32)}`,
    cumulativeAmount: '25',
    metadataHash: `0x${'55'.repeat(32)}`,
    metadata: '0x',
    spendingAuthSig: `0x${'66'.repeat(65)}`,
  }
}

function createNode(behavior: NodeBehavior): DirectAuditNode {
  const requests = new Map<string, Parameters<DirectAuditNode['sendRequest']>[1]>()
  const responses = new Map<string, Awaited<ReturnType<DirectAuditNode['sendRequest']>>>()
  return {
    async sendRequest(_target, request, options) {
      requests.set(request.requestId, request)
      if (behavior === 'timeout') {
        return new Promise((resolve, reject) => {
          const signal = options?.signal
          if (signal?.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          void resolve
        })
      }
      const answerText = Array.from({ length: 10 }, (_unused, index) =>
        `(${index + 1}) ${behavior === 'mismatch' ? index + 100 : index}`).join('\n')
      const response = {
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(behavior === 'malformed'
          ? JSON.stringify({ choices: [{ message: { content: { invalid: true } } }] })
          : JSON.stringify({
              choices: [{ message: { content: answerText } }],
              usage: { completion_tokens: 10 },
            })),
      }
      responses.set(request.requestId, response)
      return response
    },
    async waitForResponseAuth(requestId) {
      const request = requests.get(requestId)
      const response = responses.get(requestId)
      if (!request || !response) throw new Error(`missing exchange ${requestId}`)
      const auth: StoredResponseAuth = {
        version: 1,
        requestId,
        buyerPeerId: VERIFIER_PEER_ID,
        sellerPeerId: SELLER_PEER_ID,
        advertisedService: SERVICE,
        provider: 'test',
        statusCode: response.statusCode,
        requestHash: hashRequest(request),
        responseHash: hashResponse(response),
        responseStartedAt: NOW,
        responseCompletedAt: NOW + 5,
        signature: `0x${'77'.repeat(65)}`,
        receivedAt: NOW + 6,
        verified: behavior !== 'unauthenticated',
        verificationError: behavior === 'unauthenticated' ? 'bad signature' : null,
      }
      return auth
    },
    async finalizeResponsePayment() {
      if (behavior === 'payment-failure') throw new Error('payment finalization failed')
      return { sellerChargeUsdc: 25n, spendingAuth: spendingAuth() }
    },
  }
}

function createHarness(
  behavior: NodeBehavior,
  options: {
    evidenceUri?: string
    failPublication?: boolean
    onSubmit?: () => void
    resolveTrafficShare?: DirectAuditContext['resolveTrafficShare']
    epochWindows?: Array<{ epoch: bigint; startedAt: number; endsAt: number }>
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-direct-audit-'))
  const storage = new VerificationStorage(join(dir, 'verification.db'))
  const submissions: Array<Record<string, unknown>> = []
  const publications: Array<{ auditId: string; evidenceUri: string }> = []
  const warnings: string[] = []
  const epochWindows = options.epochWindows ?? [{ epoch: 7n, startedAt: 1_800_000_000, endsAt: 1_800_604_800 }]
  let epochWindowIndex = 0
  const registryClient = {
    async currentEpoch() {
      return epochWindows[Math.min(epochWindowIndex, epochWindows.length - 1)]!.epoch
    },
    async currentEpochWindow() {
      const value = epochWindows[Math.min(epochWindowIndex, epochWindows.length - 1)]!
      epochWindowIndex += 1
      return value
    },
    async submitVerificationResult(_signer: unknown, input: Record<string, unknown>) {
      options.onSubmit?.()
      submissions.push(input)
      return TX_HASH
    },
    async publishEvidence(_signer: unknown, auditId: string, evidenceUri: string) {
      publications.push({ auditId, evidenceUri })
      if (options.failPublication) throw new Error('publisher offline')
      return `0x${'88'.repeat(32)}`
    },
  } as unknown as VerifierRegistryClient
  return {
    dir,
    storage,
    target: target(),
    submissions,
    publications,
    warnings,
    context: {
      node: createNode(behavior),
      registryClient,
      storage,
      signer: {} as DirectAuditContext['signer'],
      verifierAddress: VERIFIER_ADDRESS,
      verifierPeerId: VERIFIER_PEER_ID,
      evidenceDir: join(dir, 'evidence'),
      minAuthenticatedProbeCount: 10,
      minimumStatisticalPower: 0.9,
      probeRequestTimeoutMs: 20,
      maxConcurrentProbeRequests: 2,
      now: () => NOW,
      warn: (message) => warnings.push(message),
      ...(options.resolveTrafficShare ? { resolveTrafficShare: options.resolveTrafficShare } : {}),
      resolveSubmittedEvent: async () => ({ credited: true, epoch: 7n }),
    },
    close() {
      storage.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function execute(harness: Harness, evidenceUri?: string) {
  return runDirectAudit(harness.context, {
    runId: `run-${Math.random()}`,
    source: 'manual',
    epoch: 7n,
    target: harness.target,
    service: SERVICE,
    reference: reference(),
    evidenceUri,
  })
}

test('writes canonical evidence before submitting exactly one final attestation', async () => {
  let evidenceWritten = false
  const harness = createHarness('success', {
    onSubmit: () => assert.equal(evidenceWritten, true),
  })
  harness.context.writeEvidence = async (...args) => {
    const written = await writeDirectAuditEvidence(...args)
    evidenceWritten = true
    return written
  }
  try {
    const result = await execute(harness)
    assert.equal(result.verdict, VERIFIER_VERDICT_SAME)
    assert.equal(result.authenticatedProbeCount, 10)
    assert.equal(result.credited, true)
    assert.equal(harness.submissions.length, 1)
    assert.equal(existsSync(result.evidencePath), true)
    const evidence = await verifyDirectAuditEvidenceFile(result.evidencePath, result.evidenceHash)
    assert.equal(evidence.result.verdict, 'SAME')
    assert.equal(evidence.exchanges.length, 1)
    assert.equal(harness.storage.getDirectAudit(result.runId), null)
    assert.equal(harness.storage.getDirectAudit(result.auditId)?.state, 'attested')
    assert.equal(harness.storage.listDirectAuditProbes(result.auditId).every((probe) => probe.status === 'succeeded'), true)
  } finally {
    harness.close()
  }
})

test('observation writes evidence without attesting, then explicit attestation submits once', async () => {
  const harness = createHarness('success')
  try {
    const observed = await executeDirectAuditObservation(harness.context, {
      runId: 'observation-only-run',
      source: 'automatic',
      epoch: 7n,
      target: harness.target,
      service: SERVICE,
      reference: reference(),
    })
    assert.equal(harness.submissions.length, 0)
    assert.equal(harness.storage.getDirectAudit(observed.auditId)?.state, 'completed')

    const attested = await attestCompletedDirectAudit(harness.context, observed.auditId)
    assert.equal(harness.submissions.length, 1)
    assert.equal(attested.auditId, observed.auditId)
    assert.equal(harness.storage.getDirectAudit(observed.auditId)?.state, 'attested')
  } finally {
    harness.close()
  }
})

test('observation resume reuses a succeeded stored batch after evidence writing is interrupted', async () => {
  const harness = createHarness('success')
  const originalSendRequest = harness.context.node.sendRequest.bind(harness.context.node)
  let sendCount = 0
  harness.context.node.sendRequest = async (...args) => {
    sendCount += 1
    return originalSendRequest(...args)
  }
  const input = {
    runId: 'resumable-observation',
    source: 'automatic' as const,
    epoch: 7n,
    target: harness.target,
    service: SERVICE,
    reference: reference(),
  }
  harness.context.writeEvidence = async () => {
    throw new Error('simulated evidence interruption')
  }
  try {
    await assert.rejects(executeDirectAuditObservation(harness.context, input), /simulated evidence interruption/)
    assert.equal(sendCount, 1)
    assert.equal(harness.storage.listDirectAuditExchanges(input.runId)[0]?.state, 'succeeded')

    harness.context.writeEvidence = writeDirectAuditEvidence
    const observed = await executeDirectAuditObservation(harness.context, input)
    assert.equal(sendCount, 1)
    assert.equal(harness.storage.getDirectAudit(observed.auditId)?.state, 'completed')
  } finally {
    harness.close()
  }
})

test('submits UNDETERMINED for authenticated but malformed responses', async () => {
  const harness = createHarness('malformed', {
    resolveTrafficShare: async () => { throw new Error('traffic share should not be requested') },
  })
  try {
    const result = await execute(harness)
    assert.equal(result.verdict, VERIFIER_VERDICT_UNDETERMINED)
    assert.equal(result.authenticatedProbeCount, 10)
    assert.equal(result.parsedProbeCount, 0)
    assert.equal(result.exchanges[0]?.failureReason, 'malformed completion response')
    assert.equal(harness.submissions.length, 1)
  } finally {
    harness.close()
  }
})

test('submits DIFF with the current-epoch Antscan share and stores its snapshot', async () => {
  let shareCalls = 0
  const harness = createHarness('mismatch', {
    resolveTrafficShare: async ({ sellerAddress, serviceHash, epochWindow }) => {
      shareCalls += 1
      return {
        source: 'test-antscan',
        epoch: epochWindow.epoch,
        windowStartedAt: epochWindow.startedAt,
        windowEndedAt: epochWindow.endsAt,
        indexedBlock: 123,
        sellerAddress,
        serviceHash,
        serviceVolumeUsdc: 25n,
        sellerVolumeUsdc: 100n,
        modelShareBps: 2_500,
      }
    },
  })
  try {
    const result = await execute(harness)
    assert.equal(shareCalls, 1)
    assert.equal(result.modelShareBps, 2_500)
    assert.equal(harness.submissions[0]?.expectedEpoch, 7n)
    assert.equal(harness.submissions[0]?.modelShareBps, 2_500)
    assert.deepEqual(harness.storage.getTrafficShareSnapshot(result.auditId), {
      auditId: result.auditId,
      source: 'test-antscan',
      epoch: '7',
      windowStartedAt: 1_800_000_000,
      windowEndedAt: 1_800_604_800,
      indexedBlock: 123,
      sellerAddress: `0x${SELLER_PEER_ID}`,
      serviceHash: harness.submissions[0]?.serviceHash,
      serviceVolumeUsdc: '25',
      sellerVolumeUsdc: '100',
      modelShareBps: 2_500,
      createdAt: harness.storage.getTrafficShareSnapshot(result.auditId)?.createdAt,
    })
  } finally {
    harness.close()
  }
})

test('fails closed without submission when DIFF traffic share resolution fails', async () => {
  const harness = createHarness('mismatch', {
    resolveTrafficShare: async () => { throw new Error('Antscan unavailable') },
  })
  try {
    await assert.rejects(execute(harness), /Antscan unavailable/)
    assert.equal(harness.submissions.length, 0)
    assert.match(
      harness.storage.listDirectAudits('completed')[0]?.failureReason ?? '',
      /verification result preparation failed: Antscan unavailable/,
    )
  } finally {
    harness.close()
  }
})

test('fails closed when the verification epoch changes during DIFF share calculation', async () => {
  const firstWindow = { epoch: 7n, startedAt: 1_800_000_000, endsAt: 1_800_604_800 }
  const harness = createHarness('mismatch', {
    epochWindows: [firstWindow, { epoch: 8n, startedAt: firstWindow.endsAt, endsAt: firstWindow.endsAt + 604_800 }],
    resolveTrafficShare: async ({ sellerAddress, serviceHash }) => ({
      source: 'test-antscan',
      epoch: firstWindow.epoch,
      windowStartedAt: firstWindow.startedAt,
      windowEndedAt: firstWindow.endsAt,
      indexedBlock: 123,
      sellerAddress,
      serviceHash,
      serviceVolumeUsdc: 1n,
      sellerVolumeUsdc: 10n,
      modelShareBps: 1_000,
    }),
  })
  try {
    await assert.rejects(execute(harness), /epoch changed/)
    assert.equal(harness.submissions.length, 0)
  } finally {
    harness.close()
  }
})

for (const scenario of [
  ['timeout', /only 0 authenticated paid probes/, /request timed out/] as const,
  ['unauthenticated', /only 0 authenticated paid probes/, /ResponseAuth verification failed/] as const,
  ['payment-failure', /only 0 authenticated paid probes/, /payment finalization failed/] as const,
]) {
  test(`does not attest after ${scenario[0]} probe execution`, async () => {
    const harness = createHarness(scenario[0])
    const runId = `run-${scenario[0]}`
    try {
      await assert.rejects(runDirectAudit(harness.context, {
        runId,
        source: 'manual',
        epoch: 7n,
        target: harness.target,
        service: SERVICE,
        reference: reference(),
      }), scenario[1])
      assert.equal(harness.submissions.length, 0)
      assert.equal(harness.storage.getDirectAudit(runId)?.state, 'failed')
      assert.match(harness.storage.listDirectAuditProbes(runId)[0]?.failureReason ?? '', scenario[2])
    } finally {
      harness.close()
    }
  })
}

test('keeps a successful attestation when later evidence publication fails', async () => {
  const evidenceUri = 'ipfs://direct-audit'
  const harness = createHarness('success', { failPublication: true })
  try {
    const result = await execute(harness, evidenceUri)
    assert.equal(harness.submissions.length, 1)
    assert.deepEqual(harness.publications, [{ auditId: result.auditId, evidenceUri }])
    assert.match(harness.warnings[0] ?? '', /evidence publication failed/)
    const stored = harness.storage.getDirectAudit(result.auditId)
    assert.equal(stored?.state, 'attested')
    assert.equal(stored?.evidenceUri, null)
  } finally {
    harness.close()
  }
})
