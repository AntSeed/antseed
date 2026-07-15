import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AntseedNode, ProbeJobRequestPayload } from '@antseed/node'
import { buildTargetSuggestions, MAX_TARGET_SUGGESTIONS, validateProbeJob } from './worker.js'

const SELF = 'a'.repeat(40)

function job(overrides?: {
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string | Buffer
  targetPeerId?: string
  timeoutMs?: number
}): ProbeJobRequestPayload {
  const body = overrides?.body ?? JSON.stringify({ model: 'kimi-k2', messages: [], max_tokens: 256 })
  return {
    version: 1,
    jobId: 'job-1',
    targetPeerId: overrides?.targetPeerId ?? 'b'.repeat(40),
    service: 'kimi-k2',
    request: {
      requestId: 'req-1',
      method: overrides?.method ?? 'POST',
      path: overrides?.path ?? '/v1/chat/completions',
      headers: overrides?.headers ?? { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(body).toString('base64'),
    },
    timeoutMs: overrides?.timeoutMs ?? 30_000,
  }
}

test('accepts a plain JSON chat-completion relay', () => {
  assert.equal(validateProbeJob(job(), SELF), null)
})

test('rejects non-POST and non-chat paths', () => {
  assert.equal(validateProbeJob(job({ method: 'GET' }), SELF), 'unsupported_method')
  assert.equal(validateProbeJob(job({ path: '/v1/embeddings' }), SELF), 'unsupported_path')
})

test('rejects jobs targeting the delegate itself', () => {
  assert.equal(validateProbeJob(job({ targetPeerId: SELF.toUpperCase() }), SELF), 'self_target')
})

test('rejects payment-control or other unexpected headers', () => {
  const error = validateProbeJob(
    job({ headers: { 'content-type': 'application/json', 'x-antseed-spending-auth': 'sig' } }),
    SELF,
  )
  assert.equal(error, 'disallowed_header:x-antseed-spending-auth')
})

test('bounds the relayed body and requires a JSON object', () => {
  assert.equal(validateProbeJob(job({ body: '' }), SELF), 'body_size_out_of_bounds')
  assert.equal(
    validateProbeJob(job({ body: Buffer.alloc(256 * 1024 + 1, 0x20) }), SELF),
    'body_size_out_of_bounds',
  )
  assert.equal(validateProbeJob(job({ body: 'not json' }), SELF), 'body_not_json_object')
  assert.equal(validateProbeJob(job({ body: '[1,2,3]' }), SELF), 'body_not_json_object')
})

test('the body model must be exactly the audited service', () => {
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'gpt-5.5', messages: [] }) }), SELF),
    'model_service_mismatch',
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ messages: [] }) }), SELF),
    'model_service_mismatch',
  )
})

test('streaming jobs are refused (unbounded paid response)', () => {
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], stream: true }) }), SELF),
    'streaming_not_allowed',
  )
  // Explicit stream: false is fine.
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], stream: false, max_tokens: 256 }) }), SELF),
    null,
  )
})

test('a bounded completion budget is mandatory — a body with neither field is refused', () => {
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [] }) }), SELF),
    'missing_completion_budget',
  )
  // Either spelling satisfies the requirement.
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_tokens: 256 }) }), SELF),
    null,
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_completion_tokens: 256 }) }), SELF),
    null,
  )
})

test('max_tokens is capped when present', () => {
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_tokens: 4096 }) }), SELF),
    null,
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_tokens: 4097 }) }), SELF),
    'max_tokens_out_of_bounds',
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_tokens: 0 }) }), SELF),
    'max_tokens_out_of_bounds',
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_tokens: 'lots' }) }), SELF),
    'max_tokens_out_of_bounds',
  )
})

test('max_completion_tokens is capped exactly like max_tokens', () => {
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_completion_tokens: 4096 }) }), SELF),
    null,
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], max_completion_tokens: 100_000 }) }), SELF),
    'max_completion_tokens_out_of_bounds',
  )
})

test('output-multiplying n is refused before dispatch (only the no-op n=1 relays)', () => {
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], n: 50, max_tokens: 256 }) }), SELF),
    'n_out_of_bounds',
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], n: '50', max_tokens: 256 }) }), SELF),
    'n_out_of_bounds',
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], n: 1, max_tokens: 256 }) }), SELF),
    null,
  )
})

test('body fields outside the allowlist are refused (best_of and friends)', () => {
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], best_of: 20 }) }), SELF),
    'disallowed_body_field:best_of',
  )
  assert.equal(
    validateProbeJob(job({ body: JSON.stringify({ model: 'kimi-k2', messages: [], logprobs: true }) }), SELF),
    'disallowed_body_field:logprobs',
  )
  // Fields real probes carry stay relayable.
  assert.equal(
    validateProbeJob(job({
      body: JSON.stringify({ model: 'kimi-k2', messages: [], temperature: 0, max_tokens: 800 }),
    }), SELF),
    null,
  )
})

test('rejects non-finite or non-positive timeouts', () => {
  assert.equal(validateProbeJob(job({ timeoutMs: Number.NaN }), SELF), 'invalid_timeout')
  assert.equal(validateProbeJob(job({ timeoutMs: 0 }), SELF), 'invalid_timeout')
  assert.equal(validateProbeJob(job({ timeoutMs: -1 }), SELF), 'invalid_timeout')
})

// ---------------------------------------------------------------------------
// TargetQuery answering (v2): suggest only sellers with organic paid history
// ---------------------------------------------------------------------------

function catalogPeer(peerId: string, service: string, agentId?: number): unknown {
  return {
    peerId,
    ...(agentId !== undefined ? { onChainAgentId: agentId } : {}),
    providerPricing: { openai: { services: { [service]: {} } } },
  }
}

function suggestionNode(options: {
  peers: unknown[]
  lifetimeRequestsByPeer?: Record<string, number>
  discoverError?: Error
  discoverCalls?: Array<string | undefined>
}): AntseedNode {
  return {
    async discoverPeers(service?: string): Promise<unknown[]> {
      options.discoverCalls?.push(service)
      if (options.discoverError) throw options.discoverError
      return options.peers
    },
    getMeteringStatsByPeer(peerId: string): { lifetimeRequests: number } | null {
      const lifetime = options.lifetimeRequestsByPeer?.[peerId]
      if (lifetime === undefined) return null
      return { lifetimeRequests: lifetime }
    },
  } as unknown as AntseedNode
}

test('buildTargetSuggestions returns only attestable sellers of the service with paid history', async () => {
  const discoverCalls: Array<string | undefined> = []
  const node = suggestionNode({
    peers: [
      catalogPeer('c'.repeat(40), 'kimi-k2', 7),       // history → suggested
      catalogPeer('d'.repeat(40), 'kimi-k2', 8),       // no history → dropped
      catalogPeer('e'.repeat(40), 'kimi-k2'),          // no agent id → dropped
      catalogPeer('f'.repeat(40), 'other-model', 9),   // wrong service → dropped
    ],
    lifetimeRequestsByPeer: { ['c'.repeat(40)]: 12, ['d'.repeat(40)]: 0, ['f'.repeat(40)]: 3 },
    discoverCalls,
  })
  const suggestions = await buildTargetSuggestions(node, 'Kimi-K2')
  assert.deepEqual(suggestions, [{ peerId: 'c'.repeat(40), agentId: 7 }])
  // Discovery must be scoped to the queried service (normalized), so the
  // node filters before its per-peer on-chain enrichment — never a wildcard.
  assert.deepEqual(discoverCalls, ['kimi-k2'])
})

test('buildTargetSuggestions answers empty on discovery failure or a blank service', async () => {
  const failing = suggestionNode({ peers: [], discoverError: new Error('dht down') })
  assert.deepEqual(await buildTargetSuggestions(failing, 'kimi-k2'), [])
  const healthyCalls: Array<string | undefined> = []
  const healthy = suggestionNode({ peers: [catalogPeer('c'.repeat(40), 'kimi-k2', 7)], discoverCalls: healthyCalls })
  assert.deepEqual(await buildTargetSuggestions(healthy, '   '), [])
  // A blank service never reaches discovery at all.
  assert.deepEqual(healthyCalls, [])
})

test('buildTargetSuggestions caps the answer at MAX_TARGET_SUGGESTIONS', async () => {
  const peers: unknown[] = []
  const lifetime: Record<string, number> = {}
  for (let i = 0; i < 12; i++) {
    const peerId = String(i).padStart(2, '0').repeat(20)
    peers.push(catalogPeer(peerId, 'kimi-k2', i + 1))
    lifetime[peerId] = 5
  }
  const node = suggestionNode({ peers, lifetimeRequestsByPeer: lifetime })
  const suggestions = await buildTargetSuggestions(node, 'kimi-k2')
  assert.equal(suggestions.length, MAX_TARGET_SUGGESTIONS)
})
