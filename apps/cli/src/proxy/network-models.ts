// ── Network model catalog ──
// Aggregates the buyer's discovered-peer cache into an OpenAI-style
// /v1/models payload that covers the whole network instead of a single
// pinned seller. Each model id appears once, with the peers that serve it
// (and their pricing) listed under `peers`. Callers can then pin a route
// explicitly with `<peerId>@<model>`.

import { buildNetworkServiceOffers, type PeerInfo } from '@antseed/node'

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

  for (const offer of buildNetworkServiceOffers(peers)) {
    const key = offer.serviceId.toLowerCase()
    let entry = byModelKey.get(key)
    if (!entry) {
      entry = { id: offer.serviceId, object: 'model', created, owned_by: 'antseed', type: offer.type, peers: [] }
      byModelKey.set(key, entry)
    }
    if (offer.type === 'image') entry.type = 'image'
    entry.peers.push({
      peerId: offer.peerId,
      ...(offer.displayName ? { displayName: offer.displayName } : {}),
      provider: offer.provider,
      protocols: offer.protocols,
      type: offer.type,
      ...(offer.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: offer.inputUsdPerMillion } : {}),
      ...(offer.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: offer.outputUsdPerMillion } : {}),
      ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}),
      ...(offer.minImageUsdPerImage !== undefined ? { minImageUsdPerImage: offer.minImageUsdPerImage } : {}),
      ...(offer.maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage: offer.maxImageUsdPerImage } : {}),
    })
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
