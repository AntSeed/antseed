import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, type PeerId, type PeerInfo } from '@antseed/node'
import { classifyVerificationTarget, writeRunSummary } from './model-run.js'

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
      mode: 'benchmark',
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
    assert.equal(JSON.parse(bytes).mode, 'benchmark')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
