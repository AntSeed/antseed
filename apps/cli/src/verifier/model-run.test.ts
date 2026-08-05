import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeBinomialPower,
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  hashRequest,
  hashResponse,
  type PeerId,
  type PeerInfo,
  type StoredResponseAuth,
} from '@antseed/node'
import { classifyVerificationTarget, verifyModelTarget, writeRunSummary } from './model-run.js'
import type { DirectAuditEvidenceV1 } from './direct-evidence.js'

function peer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: '11'.repeat(20) as PeerId,
    lastSeen: Date.now(),
    providers: ['test'],
    onChainAgentId: 7,
    onChainSellerAddress: `0x${'22'.repeat(20)}`,
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    providerPricing: { test: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      services: { 'GPT-5.6-SOL': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    } },
    ...overrides,
  }
}

function reference(count: number): KbfReferenceV1 {
  const probes = Array.from({ length: count }, (_, index) => ({
    id: `probe-${index + 1}`,
    name: `test probe ${index + 1}`,
    domain: 'test',
    template: `The test probe ${index + 1} value is ___.`,
    consensus: index + 1,
    range: [0, count + 10] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
  }))
  const power = computeBinomialPower({
    selfHamming: 0,
    selfTotal: count,
    minimumMismatchDelta: 0.1,
    alpha: 0.05,
    cpConfidence: 0.99,
  })
  return {
    version: 1,
    kind: 'kbf',
    referenceId: `reference-${count}`,
    referenceModel: 'gpt-5.6-sol',
    serviceAliases: ['gpt-5.6-sol'],
    createdAt: '2026-08-05T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'gpt-5.6-sol' }),
    selfTest: {
      hamming: 0,
      total: count,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: count,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [],
  }
}

async function runTarget(count: number, answerMode: 'valid' | 'out-of-range' | 'malformed' = 'valid') {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-target-'))
  const responseAuths = new Map<string, StoredResponseAuth>()
  let requestCount = 0
  let changedAnswer = false
  const node = {
    sendRequest: async (_target: PeerInfo, request: {
      requestId: string
      method: string
      path: string
      headers: Record<string, string>
      body: Uint8Array
    }) => {
      requestCount += 1
      const body = JSON.parse(new TextDecoder().decode(request.body)) as { messages: Array<{ content: string }> }
      const prompt = body.messages.at(-1)?.content ?? ''
      const values = [...prompt.matchAll(/test probe (\d+) value is ___/g)].map((match) => Number(match[1]))
      const content = values.map((value, index) => {
        if (answerMode === 'out-of-range' && !changedAnswer) {
          changedAnswer = true
          return `(${index + 1}) ${count + 100}`
        }
        return `(${index + 1}) ${value}`
      }).join('\n')
      const response = {
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(answerMode === 'malformed'
          ? { choices: [{ message: {} }] }
          : { choices: [{ message: { content } }] })),
      }
      const now = Date.now()
      responseAuths.set(request.requestId, {
        version: 1,
        requestId: request.requestId,
        buyerPeerId: '33'.repeat(20),
        sellerPeerId: '11'.repeat(20),
        advertisedService: 'GPT-5.6-SOL',
        provider: 'test',
        statusCode: 200,
        requestHash: hashRequest(request),
        responseHash: hashResponse(response),
        responseStartedAt: now,
        responseCompletedAt: now,
        signature: `0x${'00'.repeat(65)}`,
        receivedAt: now,
        verified: true,
        verificationError: null,
      })
      return response
    },
    waitForResponseAuth: async (requestId: string) => responseAuths.get(requestId)!,
    finalizeResponsePayment: async () => ({
      sellerChargeUsdc: 1n,
      spendingAuth: {
        channelId: `0x${'00'.repeat(32)}`,
        cumulativeAmount: '1',
        metadataHash: `0x${'00'.repeat(32)}`,
        metadata: '0x',
        spendingAuthSig: `0x${'00'.repeat(65)}`,
      },
    }),
  }
  const spend = { maximumUsdc: 1_000n, spentUsdc: 0n, maximumPerRequestUsdc: 1n }
  try {
    const result = await verifyModelTarget({
      context: {
        node,
        verifierAddress: `0x${'33'.repeat(20)}`,
        verifierPeerId: '33'.repeat(20),
        evidenceDir: directory,
        requestTimeoutMs: 10_000,
        spend,
      },
      target: peer(),
      service: 'GPT-5.6-SOL',
      reference: reference(count),
    })
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as DirectAuditEvidenceV1
    return { result, evidence, requestCount, spentUsdc: spend.spentUsdc }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('target eligibility preserves advertised model spelling', () => {
  assert.deepEqual(
    classifyVerificationTarget(peer(), `0x${'33'.repeat(20)}`, 'gpt-5.6-sol'),
    { eligible: true, service: 'GPT-5.6-SOL' },
  )
})

test('target eligibility requires ResponseAuth support', () => {
  assert.deepEqual(
    classifyVerificationTarget(peer({ capabilities: [] }), `0x${'33'.repeat(20)}`, 'gpt-5.6-sol'),
    { eligible: false, reason: 'missing verification.response-auth.v1' },
  )
})

test('run summaries are canonical local JSON artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-run-'))
  try {
    const path = await writeRunSummary(directory, {
      version: 1,
      kind: 'antseed-model-verification-run',
      runId: 'run-1',
      model: 'gpt-5.6-sol',
      mode: 'evidence',
      referenceId: 'reference-1',
      probeCount: 100,
      startedAt: '2026-08-04T10:00:00.000Z',
      completedAt: '2026-08-04T10:01:00.000Z',
      maximumSpendUsdc: '1000000',
      spentUsdc: '42',
      results: [],
      failures: [],
    })
    const bytes = await readFile(path, 'utf8')
    assert.equal(bytes.endsWith('\n'), false)
    assert.equal(JSON.parse(bytes).mode, 'evidence')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime uses the selected reference size for batches, spend, and evidence', async () => {
  for (const count of [100, 110, 500]) {
    const run = await runTarget(count)
    assert.equal(run.result.status, 'SAME')
    assert.equal(run.result.probeCount, count)
    assert.equal(run.result.authenticatedProbeCount, count)
    assert.equal(run.requestCount, count / 10)
    assert.equal(run.spentUsdc, BigInt(count / 10))
    assert.equal(run.evidence.result.selectedProbeCount, count)
    assert.equal(run.evidence.result.authenticatedProbeCount, count)
    assert.equal(run.evidence.result.parsedProbeCount, count)
  }
})

test('one out-of-range answer produces UNDETERMINED at full authenticated coverage', async () => {
  const run = await runTarget(100, 'out-of-range')
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.result.authenticatedProbeCount, 100)
  assert.equal(run.evidence.result.parsedProbeCount, 99)
  assert.equal(run.evidence.result.stats.targetTotal, 99)
  assert.match(run.evidence.result.verdictReason ?? '', /coverage 0\.9900 below minimum 1/)
})

test('a malformed authenticated response produces UNDETERMINED', async () => {
  const run = await runTarget(100, 'malformed')
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.result.authenticatedProbeCount, 100)
  assert.equal(run.evidence.result.parsedProbeCount, 0)
})
