import assert from 'node:assert/strict'
import test from 'node:test'
import type { StoredResponseAuth } from '@antseed/node'
import { createResponseAuthReader, validateStoredResponseAuth } from './response-auth-reader.js'

function responseAuth(overrides: Partial<StoredResponseAuth> = {}): StoredResponseAuth {
  return {
    version: 1,
    requestId: 'request-1',
    buyerPeerId: '11'.repeat(20),
    sellerPeerId: '22'.repeat(20),
    advertisedService: 'model-a',
    provider: 'test',
    statusCode: 200,
    requestHash: `0x${'33'.repeat(32)}`,
    responseHash: `0x${'44'.repeat(32)}`,
    responseStartedAt: 1,
    responseCompletedAt: 2,
    signature: `0x${'55'.repeat(65)}`,
    receivedAt: 3,
    verified: true,
    verificationError: null,
    ...overrides,
  }
}

test('ResponseAuth reader polls until the record is available', async () => {
  let calls = 0
  const reader = createResponseAuthReader({
    getResponseAuth() {
      calls += 1
      return calls < 3 ? null : responseAuth()
    },
  }, 1_000, async () => undefined)
  const result = await reader.waitForVerified({
    requestId: 'request-1', sellerPeerId: '22'.repeat(20), advertisedService: 'model-a',
  })
  assert.equal(calls, 3)
  assert.equal(result.status, 'verified')
})

test('ResponseAuth reader reports a missing record at timeout', async () => {
  const reader = createResponseAuthReader({ getResponseAuth: () => null }, 0)
  const result = await reader.waitForVerified({
    requestId: 'request-1', sellerPeerId: '22'.repeat(20), advertisedService: 'model-a',
  })
  assert.equal(result.status, 'missing')
})

test('ResponseAuth reader stops when the seller audit is aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const reader = createResponseAuthReader({ getResponseAuth: () => null }, 10_000)
  const result = await reader.waitForVerified({
    requestId: 'request-1', sellerPeerId: '22'.repeat(20), advertisedService: 'model-a',
    signal: controller.signal,
  })
  assert.equal(result.status, 'missing')
  assert.match(result.failureReason ?? '', /deadline exceeded/)
})

for (const [name, record] of [
  ['unverified', responseAuth({ verified: false, verificationError: 'bad signature' })],
  ['wrong-request', responseAuth({ requestId: 'request-2' })],
  ['wrong-seller', responseAuth({ sellerPeerId: '33'.repeat(20) })],
  ['wrong-service', responseAuth({ advertisedService: 'model-b' })],
] as const) {
  test(`ResponseAuth validation rejects ${name} records`, () => {
    const result = validateStoredResponseAuth(record, {
      requestId: 'request-1', sellerPeerId: '22'.repeat(20), advertisedService: 'model-a',
    })
    assert.equal(result.status, 'invalid')
    assert.ok(result.failureReason)
  })
}
