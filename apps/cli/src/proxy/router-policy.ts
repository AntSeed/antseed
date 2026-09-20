import { isModelRouteEligible, isModelRouteCoolingDown, isRouteRecommendation, modelRouteTotalPrice, rankModelRoutes, type ModelRouteCandidate, type ModelRoutingPreferences, type PeerInfo, type RouteRecommendation, type SerializedHttpRequest } from '@antseed/node'
import type { HierarchicalPricingConfig } from '../config/types.js'
import { effectiveModelReputationScore, normalizedModelReputationScore } from '@antseed/node'
import { findAdvertisedServiceOffer, findMissingRequiredParameters, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'
import type { ServiceApiProtocol } from './service-api-adapter.js'
import { supportsReasoningEffort } from '@antseed/api-adapter'
import { REASONING_EFFORTS, type ReasoningEffort } from '@antseed/node'

export function validateRouterCandidate(options: {
  recommendation: RouteRecommendation & { peerId: string }
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
  const { recommendation, peers, request, protocol, provider, requiredParameters, preferences, maxPricing } = options
  if (!isRouteRecommendation(recommendation) || typeof recommendation.peerId !== 'string') return null
  const peer = peers.find((entry) => entry.peerId.toLowerCase() === recommendation.peerId.toLowerCase())
  if (!peer) return null
  const plan = resolvePeerRoutePlan(peer, protocol, recommendation.serviceId, provider, 'strict')
  if (!plan?.serviceId || plan.serviceId !== recommendation.serviceId) return null
  const offer = findAdvertisedServiceOffer(peer, plan.provider, plan.serviceId)
  if (!offer || offer.capabilities?.routing === true) return null
  const targetProtocol = plan.selection?.targetProtocol ?? protocol ?? offer.protocol
  const reasoningEfforts = (offer.capabilities?.reasoning === false
    ? ['none' as const]
    : offer.capabilities?.reasoningEfforts ?? REASONING_EFFORTS)
    .filter((effort) => supportsReasoningEffort(targetProtocol, effort))
  if (recommendation.inference && !reasoningEfforts.includes(recommendation.inference.reasoningEffort)) return null
  const reasoningOverride: ReasoningEffort | null | undefined = offer.capabilities?.reasoning === false
    ? null : recommendation.inference?.reasoningEffort
  if (targetProtocol && offer.billingByProtocol?.[targetProtocol]?.kind === 'per_quantity') return null
  const missing = plan.selection?.requiresTransform
    ? requiredParameters
    : findMissingRequiredParameters(peer, plan.provider, plan.serviceId, requiredParameters)
  if (missing.length > 0) return null
  const reputation = normalizedModelReputationScore(peer)
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
  const rewritten = overrideRoutedModelInBody(request.body, request.headers, plan.serviceId, true)
  return {
    ...(recommendation.inference ? { inference: { ...recommendation.inference } } : {}),
    reasoningEfforts,
    reasoningOverride,
    peer,
    peerId: peer.peerId,
    serviceId: plan.serviceId,
    request: { ...request, body: rewritten.body, headers: rewritten.headers },
    reputation: reputation ?? -1,
    effectiveReputationScore: reputation,
    hasCachedInputPricing: offer.cachedInputUsdPerMillion !== undefined,
    inputUsdPerMillion: offer.inputUsdPerMillion ?? null,
    cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion ?? null,
    outputUsdPerMillion: offer.outputUsdPerMillion ?? null,
    minImageUsdPerImage: offer.minImageUsdPerImage ?? null,
  }
}

export function resolveRouterRecommendation(options: Omit<Parameters<typeof validateRouterCandidate>[0], 'recommendation'> & {
  recommendation: RouteRecommendation
}) {
  if (!isRouteRecommendation(options.recommendation)) return []
  const { recommendation } = options
  const matchingPeers = recommendation.peerId === undefined ? options.peers
    : options.peers.filter((peer) => peer.peerId.toLowerCase() === recommendation.peerId!.toLowerCase())
  return matchingPeers.flatMap((peer) => {
    const candidate = validateRouterCandidate({ ...options,
      recommendation: { ...recommendation, peerId: peer.peerId } })
    return candidate ? [candidate] : []
  })
}

export function rankAutomaticCandidates<T extends ModelRouteCandidate & { reputation: number; hasCachedInputPricing: boolean }>(
  candidates: T[], preferences: ModelRoutingPreferences | null, now: number, preferredPeerId?: string | null,
) {
  const preferCachedPricing = candidates.some((candidate) => candidate.hasCachedInputPricing)
  const ranked = candidates.map((candidate) => ({ ...candidate,
    effectiveReputationScore: effectiveModelReputationScore(candidate.reputation >= 0 ? candidate.reputation : null,
      candidate.hasCachedInputPricing, preferCachedPricing, modelRouteTotalPrice(candidate) === 0),
  }))
  let selected: typeof ranked
  if (preferences) {
    selected = rankModelRoutes(ranked, preferences, now).filter((candidate) => isModelRouteEligible(candidate, preferences))
  } else {
    ranked.sort((left, right) => (right.effectiveReputationScore ?? -1) - (left.effectiveReputationScore ?? -1)
      || left.peerId.localeCompare(right.peerId))
    const ready = ranked.filter((candidate) => !isModelRouteCoolingDown(candidate, now))
    selected = ready.length > 0 ? ready : ranked
  }
  if (preferredPeerId) {
    const preferredIndex = selected.findIndex((candidate) => candidate.peerId.toLowerCase() === preferredPeerId
      && !isModelRouteCoolingDown(candidate, now))
    if (preferredIndex > 0) {
      const [preferred] = selected.splice(preferredIndex, 1)
      if (preferred) selected.unshift(preferred)
    }
  }
  return selected
}
