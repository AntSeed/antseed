import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeBinomialPower,
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, type PeerId, type PeerInfo } from '@antseed/node'
import {
  classifyVerificationTarget,
  loadBuyerProxySnapshot,
  verifyModelTarget,
  writeRunSummary,
} from './model-run.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'

function peer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: '11'.repeat(20) as PeerId,
    displayName: 'Test peer',
    lastSeen: Date.now(),
    providers: ['test'],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    onChainAgentId: 7,
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

async function runTarget(
  count: number,
  answerMode: 'valid' | 'out-of-range' | 'malformed' | 'sse' | 'transport-failure' = 'valid',
  transientFailures = 0,
  authMode: 'verified' | 'missing' | 'unverified' | 'wrong-request' | 'wrong-seller' | 'wrong-service' = 'verified',
  includeCost = true,
) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-target-'))
  let requestCount = 0
  let failureCount = 0
  let changedAnswer = false
  const requests: Array<{ headers: RequestInit['headers']; body: string }> = []
  const fetchFn: typeof fetch = async (_url, init) => {
    requestCount += 1
    const requestBody = init?.body instanceof Uint8Array
      ? new TextDecoder().decode(init.body)
      : String(init?.body ?? '')
    requests.push({ headers: init?.headers ?? {}, body: requestBody })
    const body = JSON.parse(requestBody) as { messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('test probe 1 value') && failureCount < transientFailures) {
      failureCount += 1
      return new Response('temporarily unavailable', { status: 502 })
    }
    if (answerMode === 'transport-failure') return new Response('unavailable', { status: 502 })
    const values = [...prompt.matchAll(/test probe (\d+) value is ___/g)].map((match) => Number(match[1]))
    const content = values.map((value, index) => {
      if (answerMode === 'out-of-range' && !changedAnswer) {
        changedAnswer = true
        return `(${index + 1}) ${count + 100}`
      }
      return `(${index + 1}) ${value}`
    }).join('\n')
    const telemetryHeaders: Record<string, string> = includeCost ? {
      'x-antseed-input-tokens': '100',
      'x-antseed-output-tokens': '20',
      'x-antseed-total-tokens': '120',
      'x-antseed-input-usd-per-million': '1',
      'x-antseed-output-usd-per-million': '2',
      'x-antseed-estimated-cost-usd': '0.00014',
      'x-antseed-token-source': 'usage',
      'x-antseed-provider': 'test',
      'x-antseed-service': 'GPT-5.6-SOL',
    } : {}
    if (answerMode === 'sse') {
      return new Response([
        'event: response.output_text.delta',
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}`,
        '',
        'event: response.output_text.done',
        `data: ${JSON.stringify({ type: 'response.output_text.done', text: content })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { headers: {
        'content-type': 'text/event-stream',
        'x-antseed-request-id': `request-${requestCount}`,
        ...telemetryHeaders,
      } })
    }
    return Response.json(answerMode === 'malformed'
      ? { choices: [{ message: {} }] }
      : { choices: [{ message: { content } }] }, {
      headers: { 'x-antseed-request-id': `request-${requestCount}`, ...telemetryHeaders },
    })
  }
  const responseAuthReader: ResponseAuthReader = {
    async waitForVerified(input) {
      if (authMode === 'missing') {
        return { requestId: input.requestId, status: 'missing', responseAuth: null, failureReason: 'missing' }
      }
      const record = {
        version: 1 as const,
        requestId: authMode === 'wrong-request' ? 'wrong-request' : input.requestId,
        buyerPeerId: '22'.repeat(20),
        sellerPeerId: authMode === 'wrong-seller' ? '33'.repeat(20) : input.sellerPeerId,
        advertisedService: authMode === 'wrong-service' ? 'wrong-service' : input.advertisedService,
        provider: 'test',
        statusCode: 200,
        requestHash: `0x${'44'.repeat(32)}`,
        responseHash: `0x${'55'.repeat(32)}`,
        responseStartedAt: Date.now(),
        responseCompletedAt: Date.now(),
        signature: `0x${'66'.repeat(65)}`,
        receivedAt: Date.now(),
        verified: authMode !== 'unverified',
        verificationError: authMode === 'unverified' ? 'bad signature' : null,
      }
      const valid = authMode === 'verified'
      return {
        requestId: input.requestId,
        status: valid ? 'verified' : 'invalid',
        responseAuth: record,
        failureReason: valid ? null : authMode,
      }
    },
    close() {},
  }
  try {
    const result = await verifyModelTarget({
      context: {
        proxy: {
          baseUrl: 'http://127.0.0.1:8377',
          statePath: join(directory, 'buyer.state.json'),
          pid: process.pid,
          peers: [peer()],
        },
        evidenceDir: directory,
        requestTimeoutMs: 10_000,
        responseAuthReader,
        fetchFn,
        sleepFn: async () => undefined,
      },
      target: peer(),
      service: 'GPT-5.6-SOL',
      reference: reference(count),
    })
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as ProxyAuditEvidenceV1
    return { result, evidence, requestCount, requests }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('target eligibility requires ResponseAuth and preserves advertised model spelling', () => {
  assert.deepEqual(classifyVerificationTarget(peer({ capabilities: [] }), 'gpt-5.6-sol'), {
    eligible: false,
    reason: `missing ${CONNECTION_CAPABILITY_RESPONSE_AUTH_V1}`,
  })
  assert.deepEqual(classifyVerificationTarget(peer(), 'gpt-5.6-sol'), {
    eligible: true,
    service: 'GPT-5.6-SOL',
  })
})

test('buyer proxy snapshot requires a connected live daemon and parses peers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-proxy-state-'))
  try {
    await writeFile(join(directory, 'buyer.state.json'), JSON.stringify({
      state: 'connected',
      pid: process.pid,
      port: 8377,
      discoveredPeers: [peer()],
    }))
    const snapshot = await loadBuyerProxySnapshot(directory)
    assert.equal(snapshot.baseUrl, 'http://127.0.0.1:8377')
    assert.equal(snapshot.pid, process.pid)
    assert.equal(snapshot.peers.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('run summaries are canonical buyer-proxy artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-run-'))
  try {
    const path = await writeRunSummary(directory, {
      version: 1,
      kind: 'antseed-model-verification-run',
      runId: 'run-1',
      model: 'gpt-5.6-sol',
      mode: 'buyer-proxy',
      proxyBaseUrl: 'http://127.0.0.1:8377',
      referenceId: 'reference-1',
      probeCount: 100,
      startedAt: '2026-08-04T10:00:00.000Z',
      completedAt: '2026-08-04T10:01:00.000Z',
      results: [],
      failures: [],
    })
    const bytes = await readFile(path, 'utf8')
    assert.equal(bytes.endsWith('\n'), false)
    assert.equal(JSON.parse(bytes).mode, 'buyer-proxy')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('proxy runtime uses dynamic reference sizes and pins every batch', async () => {
  for (const count of [100, 110, 500]) {
    const run = await runTarget(count)
    assert.equal(run.result.status, 'SAME')
    assert.equal(run.result.probeCount, count)
    assert.equal(run.result.parsedProbeCount, count)
    assert.equal(run.result.requestCount, count / 10)
    assert.equal(run.requestCount, count / 10)
    assert.equal(run.evidence.result.selectedProbeCount, count)
    assert.equal(run.evidence.result.parsedProbeCount, count)
    assert.equal(run.evidence.evidenceLevel, 'proxy-observation-with-verified-response-auth-no-payment-evidence')
    assert.equal(run.evidence.exchanges.every((exchange) => exchange.responseAuth.status === 'verified'), true)
    assert.deepEqual({ ...run.result.cost, estimatedCostUsd: 0 }, {
      inputTokens: count * 10,
      outputTokens: count * 2,
      totalTokens: count * 12,
      estimatedCostUsd: 0,
      pricedExchangeCount: count / 10,
      missingCostExchangeCount: 0,
    })
    assert.ok(Math.abs(run.result.cost.estimatedCostUsd - (count / 10) * 0.00014) < 1e-12)
    assert.deepEqual(run.evidence.result.cost, run.result.cost)
    for (const request of run.requests) {
      assert.equal((request.headers as Record<string, string>)['x-antseed-pin-peer'], '11'.repeat(20))
    }
  }
})

test('proxy runtime retries transient failures', async () => {
  const run = await runTarget(100, 'valid', 2)
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.requestCount, 12)
  assert.equal(run.evidence.exchanges[0]?.attemptCount, 3)
})

test('one out-of-range answer remains in the fixed discrepancy denominator', async () => {
  const run = await runTarget(100, 'out-of-range')
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 1)
  assert.equal(run.evidence.result.stats.targetTotal, 100)
})

test('a malformed completed response counts every missing answer as a discrepancy', async () => {
  const run = await runTarget(100, 'malformed')
  assert.equal(run.result.status, 'DIFF')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 100)
  assert.equal(run.evidence.result.stats.targetTotal, 100)
})

test('responses SSE is decoded even when the request used stream false', async () => {
  const run = await runTarget(100, 'sse')
  assert.equal(run.result.status, 'SAME')
  assert.equal(run.result.parsedProbeCount, 100)
  assert.equal(run.evidence.result.stats.targetHamming, 0)
})

test('exhausted transport retries produce UNDETERMINED evidence', async () => {
  const run = await runTarget(100, 'transport-failure')
  assert.equal(run.result.status, 'UNDETERMINED')
  assert.equal(run.result.parsedProbeCount, 0)
  assert.equal(run.evidence.result.stats.targetTotal, 0)
  assert.equal(run.requestCount, 50)
  assert.equal(run.evidence.exchanges.every((exchange) => exchange.status === 'failed'), true)
  assert.equal(run.result.cost.pricedExchangeCount, 0)
  assert.equal(run.result.cost.missingCostExchangeCount, 10)
})

test('successful exchanges without telemetry remain explicitly unpriced', async () => {
  const run = await runTarget(100, 'valid', 0, 'verified', false)
  assert.equal(run.result.cost.estimatedCostUsd, 0)
  assert.equal(run.result.cost.pricedExchangeCount, 0)
  assert.equal(run.result.cost.missingCostExchangeCount, 10)
  assert.equal(run.evidence.exchanges.every((exchange) => exchange.cost === null), true)
})

for (const authMode of ['missing', 'unverified', 'wrong-request', 'wrong-seller', 'wrong-service'] as const) {
  test(`${authMode} ResponseAuth forces an UNDETERMINED verdict`, async () => {
    const run = await runTarget(100, 'valid', 0, authMode)
    assert.equal(run.result.status, 'UNDETERMINED')
    assert.match(run.evidence.result.verdictReason ?? '', /lacked valid verified ResponseAuth/)
  })
}
