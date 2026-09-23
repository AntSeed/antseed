import { buildNetworkServiceOffers, isModelRouteEligible, normalizedModelReputationScore, rankModelRoutes, type AntseedNode, type ModelRoutingPreferences, type PeerInfo, type RouteCandidate, type RouteRecommendation, type Router, type SerializedHttpRequest } from '@antseed/node'
import { detectRequestServiceApiProtocol } from './service-api-adapter.js'
import { findMissingRequiredParameters, getExplicitProviderOverride, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'
import { resolveRoutingPreferences, validateRoutingServiceMetadata, type RoutingSelection } from '@antseed/node'

type ExecutionCandidate = RouteCandidate & { peer: PeerInfo; effectiveReputationScore: number | null }

export function eligibleRouterCandidates(
  request: SerializedHttpRequest,
  peers: PeerInfo[],
  requiredParameters: readonly string[],
  preferences: ModelRoutingPreferences | null,
  allowsPeer: (request: SerializedHttpRequest, peer: PeerInfo) => boolean,
): ExecutionCandidate[] {
  const protocol = detectRequestServiceApiProtocol(request)
  const explicitProvider = getExplicitProviderOverride(request)
  const candidates: ExecutionCandidate[] = []
  for (const offer of buildNetworkServiceOffers(peers)) {
    const peer = peers.find(candidate => candidate.peerId === offer.peerId)
    if (!peer || offer.type !== 'text' || (explicitProvider && offer.provider !== explicitProvider)) continue
    if (peer.maxConcurrency !== undefined && peer.currentLoad !== undefined && peer.currentLoad >= peer.maxConcurrency) continue
    if (offer.inputUsdPerMillion === undefined || offer.outputUsdPerMillion === undefined) continue
    const plan = resolvePeerRoutePlan(peer, protocol, offer.serviceId, offer.provider, 'strict')
    if (!plan?.serviceId || (requiredParameters.length && plan.selection?.requiresTransform)) continue
    if (findMissingRequiredParameters(peer, offer.provider, plan.serviceId, requiredParameters).length) continue
    const rewritten = overrideRoutedModelInBody(request.body, request.headers, plan.serviceId)
    const policyRequest = { ...request, body: rewritten.body, headers: { ...rewritten.headers, 'x-antseed-provider': offer.provider } }
    if (!allowsPeer(policyRequest, peer)) continue
    const candidate = {
      peer, peerId: peer.peerId, provider: offer.provider, serviceId: plan.serviceId,
      inputUsdPerMillion: offer.inputUsdPerMillion, outputUsdPerMillion: offer.outputUsdPerMillion,
      effectiveReputationScore: normalizedModelReputationScore(peer),
    }
    if (!preferences || (isModelRouteEligible(candidate, preferences) && candidate.inputUsdPerMillion <= preferences.maxInputUsdPerMillion)) candidates.push(candidate)
  }
  if (preferences) return rankModelRoutes(candidates, preferences)
  return candidates.sort((first, second) => (second.effectiveReputationScore ?? -1) - (first.effectiveReputationScore ?? -1)
    || first.peerId.localeCompare(second.peerId))
}

export function resolveRouterRecommendation(routes: readonly RouteRecommendation[], candidates: readonly ExecutionCandidate[]): ExecutionCandidate | null {
  return resolveRouterRecommendations(routes, candidates)[0] ?? null
}

export function resolveRouterRecommendations(routes: readonly RouteRecommendation[], candidates: readonly ExecutionCandidate[]): ExecutionCandidate[] {
  if (!Array.isArray(routes) || routes.length === 0 || routes.length > 512) return []
  const resolved: ExecutionCandidate[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    if (!route || typeof route.serviceId !== 'string' || !route.serviceId || route.inference !== undefined
      || (route.peerId !== undefined && (typeof route.peerId !== 'string' || !/^[0-9a-f]{40}$/.test(route.peerId)))) continue
    for (const candidate of candidates) {
      if (candidate.serviceId !== route.serviceId || (route.peerId !== undefined && candidate.peerId !== route.peerId)) continue
      const key = JSON.stringify([candidate.peerId, candidate.provider, candidate.serviceId])
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push(candidate)
    }
  }
  return resolved
}

export function requestForRouterCandidate(request: SerializedHttpRequest, candidate: ExecutionCandidate): SerializedHttpRequest {
  const rewritten = overrideRoutedModelInBody(request.body, request.headers, candidate.serviceId)
  if (!rewritten.overridden) throw new Error('Could not apply router recommendation')
  return {
    ...request, body: rewritten.body,
    headers: { ...rewritten.headers, 'x-antseed-pin-peer': candidate.peerId, 'x-antseed-provider': candidate.provider },
  }
}

export async function executeRouterSelection(args: {
  node: Pick<AntseedNode, 'sendRequest'>;
  router: Router;
  request: SerializedHttpRequest;
  peers: PeerInfo[];
  candidates: ExecutionCandidate[];
  conversationKey: string | null;
  selection?: Extract<RoutingSelection, { kind: 'router' }>;
  signal: AbortSignal;
  onRoutingRequest?: (requestId: string) => void;
}): Promise<{ request: SerializedHttpRequest; candidates: ExecutionCandidate[] }> {
  const { node, router, request, peers, candidates, conversationKey, signal } = args
  if (!router.selectRoute) throw new Error('Selected router does not support model selection')
  const metadata = router.routingMetadata
  if (metadata) validateRoutingServiceMetadata(metadata)
  const preferences = resolveRoutingPreferences(metadata?.preferencesSchema ?? { type: 'object', properties: {}, additionalProperties: false }, args.selection?.preferences ?? {})
  const routingService = args.selection?.service ?? router.defaultRoutingService
  signal.throwIfAborted()
  let acceptedKeys: string | null = null
  const candidateKeys = (resolved: readonly ExecutionCandidate[]) => JSON.stringify(resolved.map(candidate => [candidate.peerId, candidate.provider, candidate.serviceId]))
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Routing aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const routes = await Promise.race([aborted, router.selectRoute(structuredClone(request), structuredClone(peers), {
      signal, conversationKey,
      preferences, preferencesSchemaHash: metadata?.preferencesSchemaHash,
      routingService: routingService ? structuredClone(routingService) : undefined,
      candidates: candidates.map(({ peer: _peer, effectiveReputationScore: _score, ...candidate }) => ({ ...candidate })),
      acceptRecommendations: recommendations => {
        if (signal.aborted) return false
        const resolved = resolveRouterRecommendations(recommendations, candidates)
        if (!resolved.length) return false
        const keys = candidateKeys(resolved)
        if (acceptedKeys !== null && acceptedKeys !== keys) return false
        acceptedKeys = keys
        return true
      },
      sendRequest: (peer, serviceRequest, options) => {
        if (routingService && peer.peerId !== routingService.peerId) throw new Error('Routing request must use the selected routing-service peer')
        const snapshot = structuredClone(serviceRequest)
        if (typeof snapshot.requestId !== 'string' || !snapshot.requestId || snapshot.requestId === request.requestId) {
          throw new Error('Routing purchases require a distinct request ID')
        }
        args.onRoutingRequest?.(snapshot.requestId)
        return node.sendRequest(peer, snapshot, { ...options, signal })
      },
    })])
    signal.throwIfAborted()
    const resolved = routes ? resolveRouterRecommendations(routes, candidates) : []
    if (!resolved.length || (acceptedKeys !== null && acceptedKeys !== candidateKeys(resolved))) {
      throw new Error('Selected router returned no eligible recommendation')
    }
    return {
      request: requestForRouterCandidate(request, resolved[0]!),
      candidates: resolved,
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
