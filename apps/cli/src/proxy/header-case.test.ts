import assert from 'node:assert/strict'
import test from 'node:test'
import type { SerializedHttpRequest } from '@antseed/node'
import { getHeader } from './request-utils.js'
import { getExplicitPeerIdOverride, getExplicitProviderOverride } from './routing.js'

function makeReq(headers: Record<string, string>): SerializedHttpRequest {
  return {
    requestId: 'test',
    method: 'POST',
    path: '/v1/chat/completions',
    headers,
    body: new Uint8Array(),
  }
}

test('getHeader is case-insensitive across common casings', () => {
  const headers = { 'Content-Type': 'application/json' }
  assert.equal(getHeader(headers, 'content-type'), 'application/json')
  assert.equal(getHeader(headers, 'Content-Type'), 'application/json')
  assert.equal(getHeader(headers, 'CONTENT-TYPE'), 'application/json')
})

test('getHeader returns empty string when missing', () => {
  assert.equal(getHeader({}, 'x-antseed-provider'), '')
})

test('getExplicitProviderOverride accepts mixed-case header names', () => {
  const req = makeReq({ 'X-Antseed-Provider': '  OpenAI  ' })
  assert.equal(getExplicitProviderOverride(req), 'openai')
})

test('getExplicitPeerIdOverride accepts mixed-case header names', () => {
  const peerId = 'a'.repeat(40)
  const req = makeReq({ 'X-Antseed-Pin-Peer': peerId })
  assert.equal(getExplicitPeerIdOverride(req, undefined), peerId)
})

test('getExplicitPeerIdOverride falls back to session pin when header absent', () => {
  const session = 'b'.repeat(40)
  const req = makeReq({})
  assert.equal(getExplicitPeerIdOverride(req, session), session)
})
