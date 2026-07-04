import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PeerInfo } from '@antseed/node'
import { discoverServices } from './service-discovery.js'

function peer(input: {
  id: string
  metadataServices?: string[]
  pricingServices?: string[]
  providers?: string[]
}): PeerInfo {
  return {
    peerId: input.id,
    lastSeen: 0,
    providers: input.providers ?? [],
    ...(input.metadataServices
      ? { metadata: { providers: [{ provider: 'openai', services: input.metadataServices }] } }
      : {}),
    ...(input.pricingServices
      ? {
          providerPricing: {
            openai: {
              defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
              services: Object.fromEntries(
                input.pricingServices.map((s) => [s, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]),
              ),
            },
          },
        }
      : {}),
  } as unknown as PeerInfo
}

test('enumerates services from metadata and pricing, normalized and deduped', () => {
  const result = discoverServices([
    peer({ id: 'a', metadataServices: ['Kimi-K2', 'deepseek-v3.1'], pricingServices: ['kimi-k2'] }),
  ])
  assert.deepEqual(
    result.map((r) => r.service).sort(),
    ['deepseek-v3.1', 'kimi-k2'],
  )
})

test('provider plugin names are not services', () => {
  const result = discoverServices([peer({ id: 'a', providers: ['anthropic', 'openai'] })])
  assert.deepEqual(result, [])
})

test('groups peers per service and sorts by peer count, then name', () => {
  const result = discoverServices([
    peer({ id: 'a', metadataServices: ['kimi-k2'] }),
    peer({ id: 'b', metadataServices: ['kimi-k2', 'glm-5'] }),
    peer({ id: 'c', pricingServices: ['glm-5'] }),
    peer({ id: 'd', metadataServices: ['aaa-solo'] }),
  ])
  assert.deepEqual(
    result.map((r) => `${r.service}:${r.peers.length}`),
    ['glm-5:2', 'kimi-k2:2', 'aaa-solo:1'],
  )
  assert.deepEqual(
    result.find((r) => r.service === 'kimi-k2')!.peers.map((p) => p.peerId).sort(),
    ['a', 'b'],
  )
})

test('empty and service-less peers yield no services', () => {
  assert.deepEqual(discoverServices([]), [])
  assert.deepEqual(discoverServices([peer({ id: 'a' })]), [])
  assert.deepEqual(discoverServices([peer({ id: 'a', metadataServices: ['  '] })]), [])
})
