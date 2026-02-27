import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import { selectCandidatePeersForRouting } from './buyer-proxy.js'

function makePeer(seed: string, providers: string[]): PeerInfo {
  const repeated = (seed.repeat(64) + 'a'.repeat(64)).slice(0, 64)
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
