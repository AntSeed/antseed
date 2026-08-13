// ── Network model catalog ──
// Aggregates the buyer's discovered-peer cache into an OpenAI-style
// /v1/models payload that covers the whole network instead of a single
// pinned seller. Each model id appears once, with the peers that serve it
// (and their pricing) listed under `peers`. Each peer retains its actual
// advertised `serviceId`, which callers use to pin `<peerId>@<serviceId>`.

import { buildNetworkServiceOffers, type PeerInfo } from '@antseed/node'
import { canonicalModelKey } from '@antseed/node/model-identity'

export type NetworkModelType = 'text' | 'image'

export type NetworkModelPeerOffer = {
  peerId: string
  displayName?: string
  provider: string
  serviceId: string
  protocols: string[]
  type: NetworkModelType
  reputationScore: number | null
  onChainTrustScore: number | null
  onChainReputationScore: number | null
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  cachedInputUsdPerMillion?: number
  minImageUsdPerImage?: number
  maxImageUsdPerImage?: number
}

export type NetworkModelEntry = {
  id: string
  aliases: string[]
  object: 'model'
  created: number
  owned_by: 'antseed'
  type: NetworkModelType
  peers: NetworkModelPeerOffer[]
}

export type ModelTypeFilter = 'all' | NetworkModelType | 'invalid'

function normalizedModelAlias(serviceId: string): string {
  let value = serviceId.trim().toLowerCase()
  const slash = value.lastIndexOf('/')
  if (slash >= 0) value = value.slice(slash + 1)
  return value.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

function desktopPeerReputationScore(peer: PeerInfo): number | null {
  const score = peer.onChainTrustScore ?? peer.onChainReputationScore
  return typeof score === 'number' && Number.isFinite(score) ? score : null
}

/** Maps a `?type=` query value to a filter; absent/empty means "all". */
export function parseModelTypeFilter(raw: string | null): ModelTypeFilter {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '') return 'all'
  if (value === 'image' || value === 'images') return 'image'
  if (value === 'text') return 'text'
  return 'invalid'
}

/**
 * One entry per canonical model across all discovered peers. Cosmetic naming
 * variants and conservative family aliases are grouped together, while each
 * peer offer retains its actual advertised service id for explicit routing.
 */
export function buildNetworkModels(peers: PeerInfo[], nowMs: number): NetworkModelEntry[] {
  const created = Math.floor(nowMs / 1000)
  const byModelKey = new Map<string, NetworkModelEntry>()
  const reputationByPeerId = new Map<string, number | null>()
  const peerById = new Map<string, PeerInfo>(peers.map((peer) => [peer.peerId, peer]))
  for (const peer of peers) {
    reputationByPeerId.set(peer.peerId, desktopPeerReputationScore(peer))
  }

  for (const offer of buildNetworkServiceOffers(peers)) {
    const key = canonicalModelKey(offer.serviceId)
    if (!key) continue
    let entry = byModelKey.get(key)
    if (!entry) {
      entry = {
        id: offer.serviceId,
        aliases: [],
        object: 'model',
        created,
        owned_by: 'antseed',
        type: offer.type,
        peers: [],
      }
      byModelKey.set(key, entry)
    }
    entry.aliases.push(normalizedModelAlias(offer.serviceId), key)
    if (offer.type === 'image') entry.type = 'image'
    const peer = peerById.get(offer.peerId)
    entry.peers.push({
      peerId: offer.peerId,
      ...(offer.displayName ? { displayName: offer.displayName } : {}),
      provider: offer.provider,
      serviceId: offer.serviceId,
      protocols: offer.protocols,
      type: offer.type,
      reputationScore: reputationByPeerId.get(offer.peerId) ?? null,
      onChainTrustScore: peer?.onChainTrustScore ?? null,
      onChainReputationScore: peer?.onChainReputationScore ?? null,
      ...(offer.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: offer.inputUsdPerMillion } : {}),
      ...(offer.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: offer.outputUsdPerMillion } : {}),
      ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}),
      ...(offer.minImageUsdPerImage !== undefined ? { minImageUsdPerImage: offer.minImageUsdPerImage } : {}),
      ...(offer.maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage: offer.maxImageUsdPerImage } : {}),
    })
  }

  const entries = [...byModelKey.values()]
  for (const entry of entries) {
    entry.aliases = [...new Set(entry.aliases.filter(Boolean))].sort((a, b) => a.localeCompare(b))
    entry.peers.sort((a, b) => (b.reputationScore ?? -1) - (a.reputationScore ?? -1))
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return entries
}
