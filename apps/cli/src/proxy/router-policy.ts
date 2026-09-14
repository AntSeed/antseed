import { isModelRouteEligible, type ModelRoutingPreferences, type PeerInfo, type SerializedHttpRequest } from '@antseed/node'
import type { HierarchicalPricingConfig } from '../config/types.js'
import { normalizedModelReputationScore } from './network-models.js'
import { findAdvertisedServiceOffer, findMissingRequiredParameters, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'
import type { ServiceApiProtocol } from './service-api-adapter.js'

export function validateRouterCandidate(options: {
  recommendation: { peerId: string; serviceId: string }
  peers: PeerInfo[]
  request: SerializedHttpRequest
  protocol: ServiceApiProtocol | null
  provider: string | null
  requiredParameters: string[]
  preferences: ModelRoutingPreferences | null
  maxPricing?: HierarchicalPricingConfig
  minPeerReputation?: number
  now: number
}) {
  const { recommendation, peers, request, protocol, provider, requiredParameters, preferences, maxPricing, now } = options
  if (!recommendation || typeof recommendation.peerId !== 'string' || typeof recommendation.serviceId !== 'string') return null
  const peer = peers.find((entry) => entry.peerId.toLowerCase() === recommendation.peerId.toLowerCase())
  if (!peer) return null
  const plan = resolvePeerRoutePlan(peer, protocol, recommendation.serviceId, provider, 'strict')
  if (!plan?.serviceId || plan.serviceId !== recommendation.serviceId) return null
  const offer = findAdvertisedServiceOffer(peer, plan.provider, plan.serviceId)
  if (!offer) return null
  const missing = plan.selection?.requiresTransform
    ? requiredParameters
    : findMissingRequiredParameters(peer, plan.provider, plan.serviceId, requiredParameters)
  if (missing.length > 0) return null
  const reputation = normalizedModelReputationScore(peer, now)
  if ((options.minPeerReputation ?? 0) > (reputation ?? 0)) return null
  if (preferences && !isModelRouteEligible({ peerId: peer.peerId, reputationScore: reputation }, preferences)) return null
  if (maxPricing) {
    const limits = maxPricing.defaults
    const input = offer.inputUsdPerMillion
    const output = offer.outputUsdPerMillion
    const cached = offer.cachedInputUsdPerMillion ?? input
    if (input == null || output == null || !Number.isFinite(input) || !Number.isFinite(output)
      || input < 0 || output < 0 || input > limits.inputUsdPerMillion || output > limits.outputUsdPerMillion
      || cached == null || !Number.isFinite(cached) || cached < 0
      || cached > (limits.cachedInputUsdPerMillion ?? limits.inputUsdPerMillion)) return null
  }
  const rewritten = overrideRoutedModelInBody(request.body, request.headers, plan.serviceId)
  return {
    peer,
    peerId: peer.peerId,
    serviceId: plan.serviceId,
    request: { ...request, body: rewritten.body, headers: rewritten.headers },
    reputation: reputation ?? -1,
    effectiveReputationScore: reputation,
    hasCachedInputPricing: offer.cachedInputUsdPerMillion !== undefined,
    inputUsdPerMillion: offer.inputUsdPerMillion ?? null,
    outputUsdPerMillion: offer.outputUsdPerMillion ?? null,
    minImageUsdPerImage: offer.minImageUsdPerImage ?? null,
  }
}
