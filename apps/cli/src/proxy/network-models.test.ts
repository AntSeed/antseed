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

test('merges Fable aliases and the coding-only service variant', () => {
  const branded = makePeer({
    peerId: 'a'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'claude-fable-5': ['openai-chat-completions'] } },
    },
  })
  const unbranded = makePeer({
    peerId: 'b'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'fable-5': ['openai-chat-completions'] } },
    },
  })
  const codingOnly = makePeer({
    peerId: 'c'.repeat(40),
    providerServiceApiProtocols: {
      'claude-oauth': { services: { 'fable-5-coding-only': ['anthropic-messages'] } },
    },
  })

  const models = buildNetworkModels([branded, unbranded, codingOnly], NOW_MS)

  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'claude-fable-5')
  assert.deepEqual(models[0]?.aliases, [
    'claude-fable-5',
    'fable-5',
    'fable-5-coding-only',
    'fable5',
  ])
  assert.deepEqual(models[0]?.supported_protocols, ['anthropic-messages', 'openai-chat-completions'])
  assert.deepEqual(models[0]?.peers.map((peer) => peer.serviceId), [
    'claude-fable-5',
    'fable-5',
    'fable-5-coding-only',
  ])
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

test('keeps only the lowest-priced duplicate text offer from one peer', () => {
  const peer = makePeer({
    peerId: '8'.repeat(40),
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        services: {
          'gpt-5.6-sol': { inputUsdPerMillion: 4, outputUsdPerMillion: 8 },
          'gpt-56-sol': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
      },
    },
    providerServiceApiProtocols: {
      openai: {
        services: {
          'gpt-5.6-sol': ['openai-responses'],
          'gpt-56-sol': ['openai-responses'],
        },
      },
    },
  })

  const model = buildNetworkModels([peer], NOW_MS)[0]
  assert.ok(model)
  assert.equal(model.peers.length, 1)
  assert.equal(model.peers[0]?.serviceId, 'gpt-56-sol')
  assert.equal(model.peers[0]?.inputUsdPerMillion, 1)
  assert.equal(model.peers[0]?.outputUsdPerMillion, 2)
  assert.deepEqual(model.aliases, ['gpt-5.6-sol', 'gpt-56-sol', 'gpt56sol'])
})

test('keeps only the lowest-priced duplicate image offer from one peer', () => {
  const peer = makePeer({
    peerId: '9'.repeat(40),
    providerServiceApiProtocols: {
      openai: {
        services: {
          'flux-1-schnell': ['openai-images'],
          'flux1-schnell': ['openai-images'],
        },
      },
    },
    providerServiceUnitBillingModels: {
      openai: {
        services: {
          'flux-1-schnell': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.04 }],
            },
          },
          'flux1-schnell': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.01 }],
            },
          },
        },
      },
    },
  })

  const model = buildNetworkModels([peer], NOW_MS)[0]
  assert.ok(model)
  assert.equal(model.peers.length, 1)
  assert.equal(model.peers[0]?.serviceId, 'flux1-schnell')
  assert.equal(model.peers[0]?.minImageUsdPerImage, 0.01)
})

test('prefers a known duplicate price over an unknown price', () => {
  const peer = makePeer({
    peerId: '0'.repeat(40),
    providerServiceApiProtocols: {
      openai: {
        services: {
          'flux-1-schnell': ['openai-images'],
          'flux1-schnell': ['openai-images'],
        },
      },
    },
    providerServiceUnitBillingModels: {
      openai: {
        services: {
          'flux1-schnell': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.02 }],
            },
          },
        },
      },
    },
  })

  const model = buildNetworkModels([peer], NOW_MS)[0]
  assert.equal(model?.peers[0]?.serviceId, 'flux1-schnell')
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

test('exposes peer capabilities and conservative model-level guarantees', () => {
  const first = makePeer({
    peerId: '4'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-capable': ['openai-responses'] } },
    },
    providerServiceCapabilities: {
      openai: {
        services: {
          'gpt-capable': {
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
            inputs: ['text', 'image'],
            outputs: ['text'],
            reasoning: true,
            toolUse: true,
            structuredOutput: true,
            supportedParameters: ['temperature', 'tools', 'response_format'],
          },
        },
      },
    },
    providerServiceCategories: {
      openai: { services: { 'gpt-capable': ['chat', 'reasoning'] } },
    },
  })
  const second = makePeer({
    peerId: '5'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-capable': ['openai-chat-completions'] } },
    },
    providerServiceCapabilities: {
      openai: {
        services: {
          'gpt-capable': {
            contextWindow: 128_000,
            maxOutputTokens: 32_000,
            inputs: ['text'],
            outputs: ['text'],
            reasoning: false,
            toolUse: true,
            structuredOutput: false,
            supportedParameters: ['tools', 'top_p', 'temperature'],
          },
        },
      },
    },
  })

  const model = buildNetworkModels([first, second], NOW_MS)[0]
  assert.ok(model)
  assert.deepEqual(model.supported_protocols, ['openai-chat-completions', 'openai-responses'])
  assert.equal(model.context_length, 128_000)
  assert.equal(model.max_output_tokens, 32_000)
  assert.deepEqual(model.architecture, {
    input_modalities: ['text'],
    output_modalities: ['text'],
  })
  assert.deepEqual(model.capabilities, {
    reasoning: false,
    tool_use: true,
    structured_output: false,
  })
  assert.deepEqual(model.supported_parameters, ['temperature', 'tools'])
  assert.deepEqual(model.capability_coverage, {
    total_offers: 2,
    context_length: 2,
    max_output_tokens: 2,
    input_modalities: 2,
    output_modalities: 2,
    reasoning: 2,
    tool_use: 2,
    structured_output: 2,
    supported_parameters: 2,
  })
  assert.equal(model.peers[0]?.protocol, 'openai-responses')
  assert.deepEqual(model.peers[0]?.categories, ['chat', 'reasoning'])
  assert.equal(model.peers[0]?.capabilities?.contextWindow, 200_000)
})

test('does not claim model-level guarantees when any offer omits a capability', () => {
  const reported = makePeer({
    peerId: '6'.repeat(40),
    providerServiceCapabilities: {
      openai: {
        services: {
          'partially-described': {
            contextWindow: 128_000,
            inputs: ['text', 'image'],
            toolUse: true,
          },
        },
      },
    },
  })
  const unknown = makePeer({
    peerId: '7'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'partially-described': ['openai-chat-completions'] } },
    },
  })

  const model = buildNetworkModels([reported, unknown], NOW_MS)[0]
  assert.ok(model)
  assert.equal(model.context_length, undefined)
  assert.equal(model.architecture, undefined)
  assert.equal(model.capabilities, undefined)
  assert.equal(model.supported_parameters, undefined)
  assert.equal(model.capability_coverage.context_length, 1)
  assert.equal(model.capability_coverage.input_modalities, 1)
  assert.equal(model.capability_coverage.tool_use, 1)
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
