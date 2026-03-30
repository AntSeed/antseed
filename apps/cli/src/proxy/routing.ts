import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import {
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  type ServiceApiProtocol,
  type TargetProtocolSelection,
} from './service-api-adapter.js'
import { log } from './request-utils.js'

export type PeerProtocolRoutePlan = {
  provider: string
  selection: TargetProtocolSelection | null
}

export type CandidatePeerRouteSelection = {
  candidatePeers: PeerInfo[]
  routePlanByPeerId: Map<string, PeerProtocolRoutePlan>
}

export function getExplicitProviderOverride(request: SerializedHttpRequest): string | null {
  const provider = request.headers['x-antseed-provider']?.trim().toLowerCase()
  return provider && provider.length > 0 ? provider : null
}

export function getExplicitPeerIdOverride(
  request: SerializedHttpRequest,
  sessionPinnedPeerId: string | undefined,
): string | null {
  // Per-request header takes priority over session pin
  const header = request.headers['x-antseed-pin-peer']?.trim().toLowerCase()
  if (header && header.length > 0) return header
  return sessionPinnedPeerId?.toLowerCase() ?? null
}

export function getPreferredPeerIdHint(request: SerializedHttpRequest): string | null {
  const header = request.headers['x-antseed-prefer-peer']?.trim().toLowerCase()
  if (!header || header.length === 0) {
    return null
  }
  return header
}

function getPeerProviderProtocols(
  peer: PeerInfo,
  provider: string,
  requestedService: string | null,
): ServiceApiProtocol[] {
  const normalizedRequestedService = requestedService?.trim()
  const fromMetadata = (
    peer as PeerInfo & {
      providerServiceApiProtocols?: Record<string, { services: Record<string, ServiceApiProtocol[]> }>
    }
  ).providerServiceApiProtocols?.[provider]?.services
  if (fromMetadata) {
    if (normalizedRequestedService) {
      const directMatchKey = Object.keys(fromMetadata).find(
        (key) => key.toLowerCase() === normalizedRequestedService.toLowerCase(),
      )
      if (directMatchKey && fromMetadata[directMatchKey]?.length) {
        log(
          `Service match: peer ${peer.peerId.slice(0, 8)} provider=${provider} service="${normalizedRequestedService}" `
          + `→ [${fromMetadata[directMatchKey]!.join(',')}]`,
        )
        return Array.from(new Set(fromMetadata[directMatchKey]!))
      }

      if (Object.keys(fromMetadata).length > 0) {
        log(
          `Service strict-miss: peer ${peer.peerId.slice(0, 8)} provider=${provider} service="${normalizedRequestedService}" `
          + 'not in metadata; excluding from route candidates.',
        )
        return []
      }
    }

    const merged = Object.values(fromMetadata).flat()
    if (merged.length > 0) {
      if (requestedService) {
        log(
          `Service hint miss: peer ${peer.peerId.slice(0, 8)} provider=${provider} service="${requestedService}" not in metadata; falling back to provider protocol set [${Array.from(new Set(merged)).join(',')}]`,
        )
      }
      return Array.from(new Set(merged))
    }
  }

  const inferred = inferProviderDefaultServiceApiProtocols(provider)
  log(`No metadata: peer ${peer.peerId.slice(0, 8)} provider=${provider} → inferred [${inferred.join(',')}]`)
  return inferred
}

export function resolvePeerRoutePlan(
  peer: PeerInfo,
  requestProtocol: ServiceApiProtocol | null,
  requestedService: string | null,
  explicitProvider: string | null,
): PeerProtocolRoutePlan | null {
  const providers = peer.providers
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider) => provider.length > 0)

  if (providers.length === 0) {
    return null
  }

  if (explicitProvider && !providers.includes(explicitProvider)) {
    return null
  }

  const candidates = explicitProvider ? [explicitProvider] : providers

  if (!requestProtocol) {
    const provider = candidates[0]
    return provider ? { provider, selection: null } : null
  }

  let transformedFallback: PeerProtocolRoutePlan | null = null
  for (const provider of candidates) {
    const supportedProtocols = getPeerProviderProtocols(peer, provider, requestedService)
    const selection = selectTargetProtocolForRequest(requestProtocol, supportedProtocols)
    if (!selection) {
      continue
    }
    if (!selection.requiresTransform) {
      return { provider, selection }
    }
    if (!transformedFallback) {
      transformedFallback = { provider, selection }
    }
  }

  return transformedFallback
}

export function selectCandidatePeersForRouting(
  peers: PeerInfo[],
  requestProtocol: ServiceApiProtocol | null,
  requestedService: string | null,
  explicitProvider: string | null,
): CandidatePeerRouteSelection {
  const routePlanByPeerId = new Map<string, PeerProtocolRoutePlan>()
  if (!requestProtocol && !explicitProvider) {
    return {
      candidatePeers: peers,
      routePlanByPeerId,
    }
  }

  const candidatePeers = peers.filter((peer) => {
    const plan = resolvePeerRoutePlan(peer, requestProtocol, requestedService, explicitProvider)
    if (!plan) return false
    routePlanByPeerId.set(peer.peerId, plan)
    return true
  })

  return {
    candidatePeers,
    routePlanByPeerId,
  }
}

export function pickProviderForPeer(peer: PeerInfo, request: SerializedHttpRequest): string {
  const explicit = getExplicitProviderOverride(request)
  if (explicit) {
    return explicit
  }

  if (request.path.startsWith('/v1/messages') && peer.providers.includes('anthropic')) {
    return 'anthropic'
  }

  const first = peer.providers[0]?.trim()
  if (first && first.length > 0) {
    return first.toLowerCase()
  }

  return 'unknown'
}
