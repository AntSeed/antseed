import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProbeJobRequestPayload } from '@antseed/node'
import { validateProbeJob } from './worker.js'

const SELF = 'a'.repeat(40)

function job(overrides?: {
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string | Buffer
  targetPeerId?: string
}): ProbeJobRequestPayload {
  const body = overrides?.body ?? JSON.stringify({ model: 'kimi-k2', messages: [] })
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
    timeoutMs: 30_000,
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
