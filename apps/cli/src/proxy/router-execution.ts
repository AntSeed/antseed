import { buildNetworkServiceOffers, isModelRouteEligible, normalizedModelReputationScore, rankModelRoutes, type AntseedNode, type ModelRoutingPreferences, type PeerInfo, type RouteCandidate, type RouteRecommendation, type Router, type SerializedHttpRequest } from '@antseed/node'
import { detectRequestServiceApiProtocol } from './service-api-adapter.js'
import { findMissingRequiredParameters, getExplicitProviderOverride, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'

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
  if (!Array.isArray(routes) || routes.length === 0 || routes.length > 512) return null
  for (const route of routes) {
    if (!route || typeof route.serviceId !== 'string' || !route.serviceId || route.inference !== undefined
      || (route.peerId !== undefined && (typeof route.peerId !== 'string' || !/^[0-9a-f]{40}$/.test(route.peerId)))) continue
    const candidate = candidates.find(candidate => candidate.serviceId === route.serviceId
      && (route.peerId === undefined || candidate.peerId === route.peerId))
    if (candidate) return candidate
  }
  return null
}

export async function executeRouterSelection(args: {
  node: Pick<AntseedNode, 'sendRequest'>;
  router: Router;
  request: SerializedHttpRequest;
  peers: PeerInfo[];
  candidates: ExecutionCandidate[];
  conversationKey: string | null;
  signal: AbortSignal;
}): Promise<SerializedHttpRequest> {
  const { node, router, request, peers, candidates, conversationKey, signal } = args
  if (!router.selectRoute) throw new Error('Selected router does not support model selection')
  signal.throwIfAborted()
  let accepted: ExecutionCandidate | null = null
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Routing aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const routes = await Promise.race([aborted, router.selectRoute(structuredClone(request), structuredClone(peers), {
      signal, conversationKey,
      candidates: candidates.map(({ peer: _peer, effectiveReputationScore: _score, ...candidate }) => ({ ...candidate })),
      acceptRecommendations: recommendations => {
        if (signal.aborted) return false
        accepted = resolveRouterRecommendation(recommendations, candidates)
        return accepted !== null
      },
      sendRequest: (peer, serviceRequest, options) => node.sendRequest(peer, serviceRequest, { ...options, signal }),
    })])
    signal.throwIfAborted()
    const resolved = routes ? resolveRouterRecommendation(routes, candidates) : null
    const selected = accepted as ExecutionCandidate | null
    if (!resolved || (selected && (selected.peerId !== resolved.peerId || selected.serviceId !== resolved.serviceId || selected.provider !== resolved.provider))) {
      throw new Error('Selected router returned no eligible recommendation')
    }
    const rewritten = overrideRoutedModelInBody(request.body, request.headers, resolved.serviceId)
    if (!rewritten.overridden) throw new Error('Could not apply router recommendation')
    return {
      ...request, body: rewritten.body,
      headers: { ...rewritten.headers, 'x-antseed-pin-peer': resolved.peerId, 'x-antseed-provider': resolved.provider },
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
