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
import type { PeerId, PeerInfo } from '@antseed/node'
import {
  classifyVerificationTarget,
  loadBuyerProxySnapshot,
  verifyModelTarget,
  writeRunSummary,
} from './model-run.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'

function peer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: '11'.repeat(20) as PeerId,
    displayName: 'Test peer',
    lastSeen: Date.now(),
    providers: ['test'],
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
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json(answerMode === 'malformed'
      ? { choices: [{ message: {} }] }
      : { choices: [{ message: { content } }] })
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

test('target eligibility preserves advertised model spelling without ResponseAuth requirements', () => {
  assert.deepEqual(classifyVerificationTarget(peer({ capabilities: [] }), 'gpt-5.6-sol'), {
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
    assert.equal(run.evidence.evidenceLevel, 'proxy-observation-no-response-auth-or-payment-evidence')
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
})
