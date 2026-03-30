import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import { selectCandidatePeersForRouting, rewriteServiceInBody } from './buyer-proxy.js'

function makePeer(seed: string, providers: string[]): PeerInfo {
  const repeated = (seed.repeat(40) + 'a'.repeat(40)).slice(0, 40)
  return {
    peerId: repeated as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers,
  }
}

test('selectCandidatePeersForRouting enforces explicit provider overrides even without request protocol', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['openai']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, 'openai')
  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, peers[1]?.peerId)
  assert.equal(result.routePlanByPeerId.get(peers[1]!.peerId)?.provider, 'openai')
  assert.equal(result.routePlanByPeerId.get(peers[1]!.peerId)?.selection, null)
})

test('selectCandidatePeersForRouting returns no candidates when explicit provider is unavailable', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['local-llm']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, 'openai')
  assert.equal(result.candidatePeers.length, 0)
  assert.equal(result.routePlanByPeerId.size, 0)
})

test('selectCandidatePeersForRouting keeps all peers when no protocol or provider override is set', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['openai']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, null)
  assert.deepEqual(result.candidatePeers.map((peer) => peer.peerId), peers.map((peer) => peer.peerId))
  assert.equal(result.routePlanByPeerId.size, 0)
})

test('selectCandidatePeersForRouting excludes peers when requested service is not in provider metadata', () => {
  const openAiPeer = makePeer('a', ['openai'])
  openAiPeer.providerServiceApiProtocols = {
    openai: {
      services: {
        'gpt-4o': ['openai-chat-completions'],
      },
    },
  }
  const claudePeer = makePeer('b', ['claude-oauth'])
  claudePeer.providerServiceApiProtocols = {
    'claude-oauth': {
      services: {
        'claude-opus-4-6': ['anthropic-messages'],
      },
    },
  }

  const result = selectCandidatePeersForRouting(
    [openAiPeer, claudePeer],
    'anthropic-messages',
    'claude-opus-4-6',
    null,
  )

  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, claudePeer.peerId)
  assert.equal(result.routePlanByPeerId.has(openAiPeer.peerId), false)
  assert.equal(result.routePlanByPeerId.get(claudePeer.peerId)?.provider, 'claude-oauth')
})

test('selectCandidatePeersForRouting can still include peers without service protocol metadata', () => {
  const peerWithoutMetadata = makePeer('a', ['openai'])
  const result = selectCandidatePeersForRouting(
    [peerWithoutMetadata],
    'openai-chat-completions',
    'gpt-4o',
    null,
  )

  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, peerWithoutMetadata.peerId)
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
