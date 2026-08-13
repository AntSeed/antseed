import {
  buildNetworkServiceOffers,
  type NetworkServiceOffer,
  type PeerInfo,
  type SerializedHttpRequest,
} from '@antseed/node'
import { canonicalModelKey } from '@antseed/node/model-identity'
import { selectLowestPricedModelOffer } from './network-models.js'
import {
  extractRequestBodyFields,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  type ServiceApiProtocol,
  type TargetProtocolSelection,
} from './service-api-adapter.js'
import { log, normalizePeerId } from './request-utils.js'

export type PeerProtocolRoutePlan = {
  provider: string
  selection: TargetProtocolSelection | null
  serviceId: string | null
}

export type CandidatePeerRouteSelection = {
  candidatePeers: PeerInfo[]
  routePlanByPeerId: Map<string, PeerProtocolRoutePlan>
}

// `strict` drops peers that don't advertise the requested service; `lenient`
// falls back to the provider's protocol set so a pinned peer still dispatches
// and surfaces the seller's real upstream error.
export type ServiceFilterMode = 'strict' | 'lenient'

export function getExplicitProviderOverride(request: SerializedHttpRequest): string | null {
  const provider = request.headers['x-antseed-provider']?.trim().toLowerCase()
  return provider && provider.length > 0 ? provider : null
}

export function getExplicitPeerIdOverride(
  request: SerializedHttpRequest,
  sessionPinnedPeerId: string | undefined,
  requestPinnedPeerId?: string | null,
): string | null {
  // Per-request header takes priority over session pin
  const header = request.headers['x-antseed-pin-peer']?.trim()
  if (header && header.length > 0) return normalizePeerId(header) ?? header.toLowerCase()
  if (requestPinnedPeerId) return requestPinnedPeerId.toLowerCase()
  return sessionPinnedPeerId?.toLowerCase() ?? null
}

function getPeerProviderProtocols(
  peer: PeerInfo,
  provider: string,
  requestedService: string | null,
  serviceFilterMode: ServiceFilterMode = 'strict',
): ServiceApiProtocol[] {
  const normalizedRequestedService = requestedService?.trim()
  const fromMetadata = (
    peer as PeerInfo & {
      providerServiceApiProtocols?: Record<string, { services: Record<string, ServiceApiProtocol[]> }>
    }
  ).providerServiceApiProtocols?.[provider]?.services
  if (fromMetadata) {
    if (normalizedRequestedService) {
      const requestedKey = canonicalModelKey(normalizedRequestedService)
      const directMatchKey = Object.keys(fromMetadata).find(
        (key) => canonicalModelKey(key) === requestedKey,
      )
      if (directMatchKey && fromMetadata[directMatchKey]?.length) {
        log(
          `Service match: peer ${peer.peerId.slice(0, 8)} provider=${provider} service="${normalizedRequestedService}" `
          + `→ [${fromMetadata[directMatchKey]!.join(',')}]`,
        )
        return Array.from(new Set(fromMetadata[directMatchKey]!))
      }

      if (serviceFilterMode === 'strict' && Object.keys(fromMetadata).length > 0) {
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

export function findAdvertisedServiceId(
  peer: PeerInfo,
  provider: string,
  requestedService: string,
): string | null {
  return findAdvertisedServiceOffer(peer, provider, requestedService)?.serviceId ?? null
}

export function findAdvertisedServiceOffer(
  peer: PeerInfo,
  provider: string,
  requestedService: string,
): NetworkServiceOffer | null {
  const requestedKey = canonicalModelKey(requestedService)
  if (!requestedKey) return null
  const offers = buildNetworkServiceOffers([peer]).filter((offer) => (
    offer.provider.toLowerCase() === provider.toLowerCase()
    && canonicalModelKey(offer.serviceId) === requestedKey
  ))
  if (/(?:[-:._\s]+coding[-:._\s]+only|codingonly)$/i.test(requestedService)) {
    const exact = offers.find((offer) => offer.serviceId.toLowerCase() === requestedService.trim().toLowerCase())
    if (exact) return exact
  }
  const unrestricted = offers.filter((offer) => !/(?:[-:._\s]+coding[-:._\s]+only|codingonly)$/i.test(offer.serviceId))
  return selectLowestPricedModelOffer(unrestricted.length > 0 ? unrestricted : offers)
}

function selectProviderByProtocol(
  candidates: string[],
  requestProtocol: ServiceApiProtocol,
  getSupportedProtocols: (provider: string) => ServiceApiProtocol[],
): PeerProtocolRoutePlan | null {
  let transformedFallback: PeerProtocolRoutePlan | null = null
  for (const provider of candidates) {
    const supportedProtocols = getSupportedProtocols(provider)
    const selection = selectTargetProtocolForRequest(requestProtocol, supportedProtocols)
    if (!selection) {
      continue
    }
    if (!selection.requiresTransform) {
      return { provider, selection, serviceId: null }
    }
    if (!transformedFallback) {
      transformedFallback = { provider, selection, serviceId: null }
    }
  }

  return transformedFallback
}

function selectAdvertisedServiceByProtocol(
  peer: PeerInfo,
  candidates: string[],
  requestProtocol: ServiceApiProtocol,
  requestedService: string,
): PeerProtocolRoutePlan | null {
  const compatible: Array<{ offer: NetworkServiceOffer; plan: PeerProtocolRoutePlan }> = []
  for (const provider of candidates) {
    const offer = findAdvertisedServiceOffer(peer, provider, requestedService)
    if (!offer) continue
    const supportedProtocols = offer.protocols.length > 0
      ? offer.protocols.filter((protocol): protocol is ServiceApiProtocol => (
          protocol === 'anthropic-messages'
          || protocol === 'openai-chat-completions'
          || protocol === 'openai-responses'
          || protocol === 'openai-images'
        ))
      : offer.protocol
        ? [offer.protocol]
        : []
    const selection = selectTargetProtocolForRequest(requestProtocol, supportedProtocols)
    if (!selection) continue
    compatible.push({
      offer,
      plan: { provider, selection, serviceId: offer.serviceId },
    })
  }
  const unrestricted = compatible.filter(
    ({ offer }) => !/(?:[-:._\s]+coding[-:._\s]+only|codingonly)$/i.test(offer.serviceId),
  )
  const eligible = unrestricted.length > 0 ? unrestricted : compatible
  const selectedOffer = selectLowestPricedModelOffer(eligible.map((candidate) => candidate.offer))
  return compatible.find((candidate) => candidate.offer === selectedOffer)?.plan ?? null
}

export function resolvePeerRoutePlan(
  peer: PeerInfo,
  requestProtocol: ServiceApiProtocol | null,
  requestedService: string | null,
  explicitProvider: string | null,
  serviceFilterMode: ServiceFilterMode = 'strict',
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
    const serviceId = provider && requestedService
      ? findAdvertisedServiceOffer(peer, provider, requestedService)?.serviceId ?? null
      : null
    return provider ? { provider, selection: null, serviceId } : null
  }

  if (requestedService?.trim()) {
    const exactPlan = selectAdvertisedServiceByProtocol(peer, candidates, requestProtocol, requestedService)
    if (exactPlan) return exactPlan
    const hasAdvertisedCanonicalOffer = candidates.some(
      (provider) => findAdvertisedServiceOffer(peer, provider, requestedService) !== null,
    )
    if (hasAdvertisedCanonicalOffer) return null
  }

  return selectProviderByProtocol(
    candidates,
    requestProtocol,
    (provider) => getPeerProviderProtocols(peer, provider, requestedService, serviceFilterMode),
  )
}

export function selectCandidatePeersForRouting(
  peers: PeerInfo[],
  requestProtocol: ServiceApiProtocol | null,
  requestedService: string | null,
  explicitProvider: string | null,
  serviceFilterMode: ServiceFilterMode = 'strict',
): CandidatePeerRouteSelection {
  const routePlanByPeerId = new Map<string, PeerProtocolRoutePlan>()
  if (!requestProtocol && !explicitProvider) {
    return {
      candidatePeers: peers,
      routePlanByPeerId,
    }
  }

  const candidatePeers = peers.filter((peer) => {
    const plan = resolvePeerRoutePlan(peer, requestProtocol, requestedService, explicitProvider, serviceFilterMode)
    if (!plan) return false
    routePlanByPeerId.set(peer.peerId, plan)
    return true
  })

  return {
    candidatePeers,
    routePlanByPeerId,
  }
}

// Protocol-core request fields that are never flagged against a peer's
// announced supportedParameters: the announced list describes optional
// extras, not the fields every request on that protocol carries.
const PROTOCOL_BASELINE_FIELDS: Partial<Record<ServiceApiProtocol, readonly string[]>> = {
  'openai-images': ['model', 'prompt', 'image', 'mask', 'n', 'stream'],
  'openai-chat-completions': ['model', 'messages', 'stream'],
  'openai-responses': ['model', 'input', 'stream'],
  'anthropic-messages': ['model', 'messages', 'max_tokens', 'stream'],
}

/**
 * Soft pre-flight check against the peer's announced `supportedParameters`
 * capability: returns request-body parameter names the peer did not announce
 * for the routed service. Empty when the peer announces no list (absence
 * means unknown, not unsupported) or the body is not parseable. Callers log
 * a warning — never reject — since the list is a hint, not a contract.
 */
export function findUnannouncedRequestParameters(
  peer: PeerInfo,
  provider: string,
  requestedService: string | null,
  requestProtocol: ServiceApiProtocol | null,
  request: SerializedHttpRequest,
): string[] {
  const normalizedService = requestedService?.trim().toLowerCase()
  if (!requestProtocol || !normalizedService) return []

  const providerKey = Object.keys(peer.providerServiceCapabilities ?? {})
    .find((key) => key.toLowerCase() === provider.toLowerCase())
  const services = providerKey ? peer.providerServiceCapabilities?.[providerKey]?.services : undefined
  if (!services) return []
  const serviceKey = Object.keys(services).find((key) => key.toLowerCase() === normalizedService)
  const announced = serviceKey ? services[serviceKey]?.supportedParameters : undefined
  if (!announced || announced.length === 0) return []

  const fields = extractRequestBodyFields(request.headers, request.body)
  if (!fields) return []
  const allowed = new Set<string>([...announced, ...(PROTOCOL_BASELINE_FIELDS[requestProtocol] ?? [])])
  return Object.keys(fields).filter((key) => !allowed.has(key))
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
