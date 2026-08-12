// ── Network model catalog ──
// Aggregates the buyer's discovered-peer cache into an OpenAI-style
// /v1/models payload that covers the whole network instead of a single
// pinned seller. Each model id appears once, with the peers that serve it
// (and their pricing) listed under `peers`. Callers can then pin a route
// explicitly with `<peerId>@<model>`.

import type { PeerInfo } from '@antseed/node'

export type NetworkModelType = 'text' | 'image'

export type NetworkModelPeerOffer = {
  peerId: string
  displayName?: string
  provider: string
  protocols: string[]
  type: NetworkModelType
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  cachedInputUsdPerMillion?: number
  minImageUsdPerImage?: number
  maxImageUsdPerImage?: number
}

export type NetworkModelEntry = {
  id: string
  object: 'model'
  created: number
  owned_by: 'antseed'
  type: NetworkModelType
  peers: NetworkModelPeerOffer[]
}

export type ModelTypeFilter = 'all' | NetworkModelType | 'invalid'

/** Maps a `?type=` query value to a filter; absent/empty means "all". */
export function parseModelTypeFilter(raw: string | null): ModelTypeFilter {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '') return 'all'
  if (value === 'image' || value === 'images') return 'image'
  if (value === 'text') return 'text'
  return 'invalid'
}

/**
 * Every (provider, serviceId) a peer announces — the union across all five
 * per-provider service matrices, since a service may appear in any of them.
 */
function announcedServicesByProvider(peer: PeerInfo): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>()
  const matrices: Array<Record<string, { services?: Record<string, unknown> }> | undefined> = [
    peer.providerPricing,
    peer.providerServiceApiProtocols,
    peer.providerServiceCategories,
    peer.providerServiceUnitBillingModels,
    peer.providerServiceCapabilities,
  ]
  for (const matrix of matrices) {
    for (const [provider, entry] of Object.entries(matrix ?? {})) {
      let serviceIds = byProvider.get(provider)
      if (!serviceIds) {
        serviceIds = new Set()
        byProvider.set(provider, serviceIds)
      }
      for (const id of Object.keys(entry.services ?? {})) {
        if (id.trim().length > 0) serviceIds.add(id)
      }
    }
  }
  return byProvider
}

function buildPeerOffer(peer: PeerInfo, provider: string, serviceId: string): NetworkModelPeerOffer {
  const protocols = peer.providerServiceApiProtocols?.[provider]?.services[serviceId] ?? []
  const capabilities = peer.providerServiceCapabilities?.[provider]?.services[serviceId]
  const isImage = protocols.includes('openai-images') || capabilities?.outputs?.includes('image') === true

  const pricingEntry = peer.providerPricing?.[provider]
  const pricing = pricingEntry?.services?.[serviceId] ?? pricingEntry?.defaults
  const inputUsdPerMillion = pricing?.inputUsdPerMillion ?? peer.defaultInputUsdPerMillion
  const outputUsdPerMillion = pricing?.outputUsdPerMillion ?? peer.defaultOutputUsdPerMillion
  const cachedInputUsdPerMillion = pricing?.cachedInputUsdPerMillion ?? peer.defaultCachedInputUsdPerMillion

  let minImageUsdPerImage: number | undefined
  let maxImageUsdPerImage: number | undefined
  const billingByProtocol = peer.providerServiceUnitBillingModels?.[provider]?.services[serviceId]
  for (const model of Object.values(billingByProtocol ?? {})) {
    for (const component of model?.components ?? []) {
      if (component.unit !== 'output_images' || !Number.isFinite(component.priceUsd)) continue
      minImageUsdPerImage = minImageUsdPerImage === undefined ? component.priceUsd : Math.min(minImageUsdPerImage, component.priceUsd)
      maxImageUsdPerImage = maxImageUsdPerImage === undefined ? component.priceUsd : Math.max(maxImageUsdPerImage, component.priceUsd)
    }
  }

  return {
    peerId: peer.peerId,
    ...(peer.displayName ? { displayName: peer.displayName } : {}),
    provider,
    protocols,
    type: isImage ? 'image' : 'text',
    ...(inputUsdPerMillion !== undefined ? { inputUsdPerMillion } : {}),
    ...(outputUsdPerMillion !== undefined ? { outputUsdPerMillion } : {}),
    ...(cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion } : {}),
    ...(minImageUsdPerImage !== undefined ? { minImageUsdPerImage } : {}),
    ...(maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage } : {}),
  }
}

/**
 * One entry per model id across all discovered peers. Models are grouped
 * case-insensitively (the first-seen spelling wins); a model counts as an
 * image model when any peer announces it with the `openai-images` protocol
 * or with `image` in its capability outputs.
 */
export function buildNetworkModels(peers: PeerInfo[], nowMs: number): NetworkModelEntry[] {
  const created = Math.floor(nowMs / 1000)
  const byModelKey = new Map<string, NetworkModelEntry>()
  const reputationByPeerId = new Map<string, number>()
  for (const peer of peers) {
    reputationByPeerId.set(peer.peerId, peer.reputationScore ?? -1)
  }

  for (const peer of peers) {
    for (const [provider, serviceIds] of announcedServicesByProvider(peer)) {
      for (const serviceId of serviceIds) {
        const offer = buildPeerOffer(peer, provider, serviceId)
        const key = serviceId.toLowerCase()
        let entry = byModelKey.get(key)
        if (!entry) {
          entry = { id: serviceId, object: 'model', created, owned_by: 'antseed', type: offer.type, peers: [] }
          byModelKey.set(key, entry)
        }
        if (offer.type === 'image') entry.type = 'image'
        entry.peers.push(offer)
      }
    }
  }

  const entries = [...byModelKey.values()]
  for (const entry of entries) {
    entry.peers.sort((a, b) => (
      (reputationByPeerId.get(b.peerId) ?? -1) - (reputationByPeerId.get(a.peerId) ?? -1)
      || a.peerId.localeCompare(b.peerId)
      || a.provider.localeCompare(b.provider)
    ))
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return entries
}
