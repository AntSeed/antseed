import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo } from '@antseed/node'
import { buildNetworkModels, parseModelTypeFilter } from './network-models.js'

const NOW_MS = 1_700_000_000_000

function makePeer(overrides: Omit<Partial<PeerInfo>, 'peerId'> & { peerId: string }): PeerInfo {
  return {
    lastSeen: NOW_MS,
    providers: [],
    ...overrides,
    peerId: overrides.peerId as PeerInfo['peerId'],
  }
}

const textSeller = makePeer({
  peerId: 'a'.repeat(40),
  displayName: 'Text Seller',
  onChainTrustScore: 40,
  onChainReputationScore: 35,
  providerPricing: {
    openai: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      services: {
        'qwen3-coder': { inputUsdPerMillion: 3, outputUsdPerMillion: 9, cachedInputUsdPerMillion: 0.3 },
      },
    },
  },
  providerServiceApiProtocols: {
    openai: { services: { 'qwen3-coder': ['openai-chat-completions'] } },
  },
})

const imageSeller = makePeer({
  peerId: 'b'.repeat(40),
  onChainTrustScore: 80,
  onChainReputationScore: 75,
  providerPricing: {
    openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
  },
  providerServiceApiProtocols: {
    openai: { services: { 'flux-1-schnell': ['openai-images'] } },
  },
  providerServiceUnitBillingModels: {
    openai: {
      services: {
        'flux-1-schnell': {
          'openai-images': {
            version: 1,
            components: [
              { unit: 'output_images', priceUsd: 0.01, match: { size: '512x512' } },
              { unit: 'output_images', priceUsd: 0.05, match: { size: '1024x1024' } },
            ],
          },
        },
      },
    },
  },
})

// Announces the same text model as textSeller (different id casing) plus an
// image model identified only via capability outputs — no protocol announced.
const mixedSeller = makePeer({
  peerId: 'c'.repeat(40),
  onChainTrustScore: 90,
  onChainReputationScore: 85,
  providerPricing: {
    'local-llm': { defaults: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 0.7 } },
  },
  providerServiceCapabilities: {
    'local-llm': {
      services: {
        'QWEN3-Coder': { outputs: ['text'] },
        'sdxl-turbo': { outputs: ['image'] },
      },
    },
  },
})

test('parseModelTypeFilter maps query values', () => {
  assert.equal(parseModelTypeFilter(null), 'all')
  assert.equal(parseModelTypeFilter(''), 'all')
  assert.equal(parseModelTypeFilter('images'), 'image')
  assert.equal(parseModelTypeFilter('Image'), 'image')
  assert.equal(parseModelTypeFilter('text'), 'text')
  assert.equal(parseModelTypeFilter('audio'), 'invalid')
})

test('aggregates one entry per model id across peers, case-insensitively', () => {
  const models = buildNetworkModels([textSeller, imageSeller, mixedSeller], NOW_MS)
  assert.deepEqual(models.map((model) => model.id), ['flux-1-schnell', 'qwen3-coder', 'sdxl-turbo'])

  const qwen = models.find((model) => model.id === 'qwen3-coder')
  assert.ok(qwen)
  assert.equal(qwen.type, 'text')
  assert.equal(qwen.object, 'model')
  assert.equal(qwen.owned_by, 'antseed')
  assert.equal(qwen.created, Math.floor(NOW_MS / 1000))
  assert.deepEqual(qwen.aliases, ['qwen3-coder', 'qwen3coder'])
  // Higher-reputation peer first.
  assert.deepEqual(qwen.peers.map((peer) => peer.peerId), [mixedSeller.peerId, textSeller.peerId])
  assert.deepEqual(qwen.peers.map((peer) => peer.reputationScore), [90, 40])
  assert.deepEqual(qwen.peers.map((peer) => peer.onChainTrustScore), [90, 40])
  assert.deepEqual(qwen.peers.map((peer) => peer.onChainReputationScore), [85, 35])
  assert.deepEqual(qwen.peers.map((peer) => peer.serviceId), ['QWEN3-Coder', 'qwen3-coder'])
})

test('sorts by on-chain trust before on-chain reputation like desktop VPR', () => {
  const reputationOnlySeller = makePeer({
    peerId: 'f'.repeat(40),
    onChainReputationScore: 95,
    providerServiceApiProtocols: {
      openai: { services: { 'qwen3-coder': ['openai-chat-completions'] } },
    },
  })

  const models = buildNetworkModels([mixedSeller, reputationOnlySeller], NOW_MS)
  const qwen = models.find((model) => model.id === 'QWEN3-Coder')
  assert.ok(qwen)
  assert.deepEqual(qwen.peers.map((peer) => peer.peerId), [reputationOnlySeller.peerId, mixedSeller.peerId])
  assert.deepEqual(qwen.peers.map((peer) => peer.reputationScore), [95, 90])
  assert.deepEqual(qwen.peers.map((peer) => peer.onChainTrustScore), [null, 90])
})

test('returns null reputation and sorts unknown scores last', () => {
  const unknownSeller = makePeer({
    peerId: '0'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'qwen3-coder': ['openai-chat-completions'] } },
    },
  })

  const models = buildNetworkModels([unknownSeller, textSeller], NOW_MS)
  const qwen = models.find((model) => model.id === 'qwen3-coder')
  assert.ok(qwen)
  assert.deepEqual(qwen.peers.map((peer) => peer.peerId), [textSeller.peerId, unknownSeller.peerId])
  assert.deepEqual(qwen.peers.map((peer) => peer.reputationScore), [40, null])
})

test('merges conservative family aliases while preserving advertised service ids', () => {
  const branded = makePeer({
    peerId: 'd'.repeat(40),
    providerServiceApiProtocols: {
      anthropic: { services: { 'claude-opus-5': ['anthropic-messages'] } },
    },
  })
  const unbranded = makePeer({
    peerId: 'e'.repeat(40),
    providerServiceApiProtocols: {
      anthropic: { services: { 'Opus 5': ['anthropic-messages'] } },
    },
  })

  const models = buildNetworkModels([branded, unbranded], NOW_MS)

  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'claude-opus-5')
  assert.deepEqual(models[0]?.aliases, ['claude-opus-5', 'opus-5', 'opus5'])
  assert.deepEqual(models[0]?.peers.map((peer) => peer.serviceId), ['claude-opus-5', 'Opus 5'])
})

test('merges compact numeric versions and flattened vendor prefixes', () => {
  const dotted = makePeer({
    peerId: '1'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-5.6-sol': ['openai-responses'] } },
    },
  })
  const compact = makePeer({
    peerId: '2'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-56-sol': ['openai-responses'] } },
    },
  })
  const vendorPrefixed = makePeer({
    peerId: '3'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'openai-gpt-56-sol': ['openai-responses'] } },
    },
  })

  const models = buildNetworkModels([dotted, compact, vendorPrefixed], NOW_MS)

  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'gpt-5.6-sol')
  assert.deepEqual(models[0]?.aliases, ['gpt-5.6-sol', 'gpt-56-sol', 'gpt56sol', 'openai-gpt-56-sol'])
  assert.deepEqual(models[0]?.peers.map((peer) => peer.serviceId), [
    'gpt-5.6-sol',
    'gpt-56-sol',
    'openai-gpt-56-sol',
  ])
})

test('service pricing overrides provider defaults', () => {
  const models = buildNetworkModels([textSeller], NOW_MS)
  const offer = models[0]?.peers[0]
  assert.ok(offer)
  assert.equal(offer.inputUsdPerMillion, 3)
  assert.equal(offer.outputUsdPerMillion, 9)
  assert.equal(offer.cachedInputUsdPerMillion, 0.3)
  assert.equal(offer.displayName, 'Text Seller')
})

test('image models are detected via protocol or capability outputs', () => {
  const models = buildNetworkModels([textSeller, imageSeller, mixedSeller], NOW_MS)
  const flux = models.find((model) => model.id === 'flux-1-schnell')
  const sdxl = models.find((model) => model.id === 'sdxl-turbo')
  assert.equal(flux?.type, 'image')
  assert.equal(sdxl?.type, 'image')
  assert.equal(flux?.peers[0]?.minImageUsdPerImage, 0.01)
  assert.equal(flux?.peers[0]?.maxImageUsdPerImage, 0.05)
})

test('type filter splits text and image models', () => {
  const models = buildNetworkModels([textSeller, imageSeller, mixedSeller], NOW_MS)
  const images = models.filter((model) => model.type === 'image')
  const text = models.filter((model) => model.type === 'text')
  assert.deepEqual(images.map((model) => model.id), ['flux-1-schnell', 'sdxl-turbo'])
  assert.deepEqual(text.map((model) => model.id), ['qwen3-coder'])
})

test('returns an empty list when no peers are discovered', () => {
  assert.deepEqual(buildNetworkModels([], NOW_MS), [])
})
