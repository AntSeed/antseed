import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRequestBody,
  estimateBatchMaximumUsdcBase,
  extractCompletionText,
  resolveMaximumServicePricing,
  summarizeKbfResult,
} from './run-kbf-proxy-sweep.mjs'
import { buildKbfChatRequestBody } from '../packages/fingerprints/dist/index.js'

test('extractCompletionText supports chat JSON and responses SSE', () => {
  assert.equal(extractCompletionText(JSON.stringify({
    choices: [{ message: { content: '(1) 42' } }],
  })), '(1) 42')
  assert.equal(extractCompletionText(JSON.stringify({
    choices: [{ message: { content: '', reasoning_content: '(1) 42' } }],
  })), '(1) 42')
  assert.equal(extractCompletionText([
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"(1) "}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"42"}',
    '',
    'data: [DONE]',
  ].join('\n')), '(1) 42')
})

test('resolveMaximumServicePricing chooses the conservative offered price', () => {
  const pricing = resolveMaximumServicePricing({
    peerId: 'peer',
    displayName: 'Peer',
    providerPricing: {
      cheap: { services: { 'gpt-5.6-sol': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
      expensive: { services: { 'GPT-5.6-SOL': { inputUsdPerMillion: 3, outputUsdPerMillion: 4 } } },
    },
  }, 'gpt-5.6-sol')
  assert.deepEqual(pricing, {
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 4,
    providers: ['cheap', 'expensive'],
  })
})

test('estimateBatchMaximumUsdcBase applies a conservative byte/token bound and buffer', () => {
  const body = { messages: [{ content: 'abcd' }], max_tokens: 10 }
  const withoutBuffer = estimateBatchMaximumUsdcBase(
    body,
    { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    0,
  )
  const withBuffer = estimateBatchMaximumUsdcBase(
    body,
    { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    1_000,
  )
  assert.ok(withoutBuffer > 20n)
  assert.ok(withBuffer > withoutBuffer)
})

test('analytics batches use the same frozen target prompt as the direct verifier', () => {
  const reference = {
    queryProfile: {
      maxTokensPerRequest: 1600,
      generationSettings: { topP: 1 },
      requestOverrides: { reasoning_effort: 'none' },
    },
  }
  const probes = [{
    id: 'probe-1',
    name: 'Example quantity',
    domain: 'test',
    template: 'The numerical value is ___.',
    consensus: 42,
    range: [0, 100],
    tolerance: { mode: 'absolute', value: 0 },
  }]
  assert.deepEqual(
    buildRequestBody(reference, 'gpt-5.6-sol', probes),
    {
      ...buildKbfChatRequestBody('gpt-5.6-sol', probes, { maxTokens: 1600 }),
      top_p: 1,
      stream: false,
      n: 1,
      reasoning_effort: 'none',
    },
  )
})

test('analytics reports omit answer vectors and vector hashes', () => {
  const summary = summarizeKbfResult({
    verifier: { kind: 'kbf' },
    referenceId: 'reference-1',
    referenceModel: 'gpt-5.6-sol',
    probeCount: 50,
    parsedProbeCount: 49,
    matchVector: [1, 0, null],
    matchVectorHash: 'sha256:private-vector-hash',
    stats: { targetHamming: 12 },
    verdict: 'DIFF',
    verdictReason: 'binomial threshold exceeded',
  })

  assert.deepEqual(summary, {
    verifier: { kind: 'kbf' },
    referenceId: 'reference-1',
    referenceModel: 'gpt-5.6-sol',
    probeCount: 50,
    parsedProbeCount: 49,
    stats: { targetHamming: 12 },
    verdict: 'DIFF',
    verdictReason: 'binomial threshold exceeded',
  })
  assert.equal('matchVector' in summary, false)
  assert.equal('matchVectorHash' in summary, false)
})
