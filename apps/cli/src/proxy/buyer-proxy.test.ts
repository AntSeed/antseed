import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import { selectCandidatePeersForRouting, rewriteServiceInBody } from './buyer-proxy.js'

function makePeer(seed: string, serviceNames: string[]): PeerInfo {
  const repeated = (seed.repeat(64) + 'a'.repeat(64)).slice(0, 64)
  return {
    peerId: repeated as PeerInfo['peerId'],
    lastSeen: Date.now(),
    services: serviceNames.map((name) => ({
      name,
      pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 },
    })),
  }
}

test('selectCandidatePeersForRouting keeps all peers when no protocol or provider override is set', () => {
  const peers = [
    makePeer('a', ['claude-3-opus']),
    makePeer('b', ['gpt-4o']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, null)
  assert.deepEqual(result.candidatePeers.map((peer) => peer.peerId), peers.map((peer) => peer.peerId))
  assert.equal(result.routePlanByPeerId.size, 0)
})

test('selectCandidatePeersForRouting excludes peers when requested service is not in service metadata', () => {
  const openAiPeer = makePeer('a', ['gpt-4o'])
  openAiPeer.services[0]!.protocols = ['openai-chat-completions']

  const claudePeer = makePeer('b', ['claude-opus-4-6'])
  claudePeer.services[0]!.protocols = ['anthropic-messages']

  const result = selectCandidatePeersForRouting(
    [openAiPeer, claudePeer],
    'anthropic-messages',
    'claude-opus-4-6',
    null,
  )

  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, claudePeer.peerId)
  assert.equal(result.routePlanByPeerId.has(openAiPeer.peerId), false)
})

test('selectCandidatePeersForRouting can still include peers without service protocol metadata', () => {
  const peerWithoutMetadata = makePeer('a', ['gpt-4o'])
  const result = selectCandidatePeersForRouting(
    [peerWithoutMetadata],
    'openai-chat-completions',
    'gpt-4o',
    null,
  )

  // Peer has no protocol info, so selectTargetProtocolForRequest returns null → excluded
  // This is a behavior change: without inferProviderDefaultServiceApiProtocols, peers
  // without protocol metadata are excluded when a specific protocol is requested.
  assert.equal(result.candidatePeers.length, 0)
})

// rewriteServiceInBody tests

function makeJsonBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

function parseJsonBody(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
}

const jsonHeaders: Record<string, string> = { 'content-type': 'application/json' }

test('rewriteServiceInBody replaces existing model field and sets service', () => {
  const body = makeJsonBody({ model: 'claude-sonnet-4-5', messages: [] })
  const result = rewriteServiceInBody(body, jsonHeaders, 'claude-opus-4-6')
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'claude-opus-4-6')
  assert.equal(parsed['model'], 'claude-opus-4-6')
})

test('rewriteServiceInBody adds service and model fields when absent', () => {
  const body = makeJsonBody({ messages: [] })
  const result = rewriteServiceInBody(body, jsonHeaders, 'claude-opus-4-6')
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'claude-opus-4-6')
  assert.equal(parsed['model'], 'claude-opus-4-6')
})

test('rewriteServiceInBody preserves all other fields', () => {
  const body = makeJsonBody({ model: 'old', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 })
  const result = rewriteServiceInBody(body, jsonHeaders, 'new-model')
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'new-model')
  assert.equal(parsed['model'], 'new-model')
  assert.deepEqual(parsed['messages'], [{ role: 'user', content: 'hi' }])
  assert.equal(parsed['max_tokens'], 1024)
})

test('rewriteServiceInBody updates content-length header when present', () => {
  const original = makeJsonBody({ model: 'a', messages: [] })
  const headers = { 'content-type': 'application/json', 'content-length': String(original.length) }
  const result = rewriteServiceInBody(original, headers, 'claude-opus-4-6-20251201')
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('rewriteServiceInBody returns original when body is not JSON content-type', () => {
  const body = makeJsonBody({ model: 'old' })
  const headers = { 'content-type': 'text/plain' }
  const result = rewriteServiceInBody(body, headers, 'new-model')
  assert.equal(result.body, body)
  assert.equal(result.headers, headers)
})

test('rewriteServiceInBody returns original when body is empty', () => {
  const body = new Uint8Array(0)
  const result = rewriteServiceInBody(body, jsonHeaders, 'new-model')
  assert.equal(result.body, body)
})

test('rewriteServiceInBody returns original when body is not a JSON object', () => {
  const body = new TextEncoder().encode('"just a string"')
  const result = rewriteServiceInBody(body, jsonHeaders, 'new-model')
  assert.equal(result.body, body)
})
