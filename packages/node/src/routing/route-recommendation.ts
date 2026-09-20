import type { RouteRecommendation } from '../interfaces/buyer-router.js';
import { isReasoningEffort, type ReasoningEffort } from '@antseed/protocol';

type EligibleCandidate = { serviceId: string; peerId: string; reasoningEfforts?: ReasoningEffort[] };

export function isRouteRecommendation(value: unknown): value is RouteRecommendation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  if (route.inference !== undefined) {
    if (!route.inference || typeof route.inference !== 'object' || Array.isArray(route.inference)) return false;
    const inference = route.inference as Record<string, unknown>;
    if (Object.keys(inference).some((key) => key !== 'reasoningEffort')
      || !isReasoningEffort(inference.reasoningEffort)) return false;
  }
  return typeof route.serviceId === 'string' && route.serviceId.length > 0
    && (route.peerId === undefined || (typeof route.peerId === 'string' && route.peerId.length > 0));
}

export function isRouteRecommendationEligible(
  value: unknown,
  candidates: readonly EligibleCandidate[],
): value is RouteRecommendation {
  return isRouteRecommendation(value) && candidates.some((candidate) => candidate.serviceId === value.serviceId
    && (value.peerId === undefined || candidate.peerId === value.peerId)
    && (value.inference === undefined
      || candidate.reasoningEfforts?.includes(value.inference.reasoningEffort) === true));
}

export function areRouteRecommendationsEligible(
  value: unknown,
  candidates: readonly EligibleCandidate[],
): value is RouteRecommendation[] {
  const maxRecommendations = candidates.length + new Set(candidates.map((candidate) => candidate.serviceId)).size;
  if (!Array.isArray(value) || value.length === 0 || value.length > maxRecommendations) return false;
  const seen = new Set<string>();
  for (const route of value) {
    if (!isRouteRecommendationEligible(route, candidates)
      || Object.keys(route).some((key) => !['serviceId', 'peerId', 'inference'].includes(key))) return false;
    const key = JSON.stringify([route.serviceId, route.peerId ?? null]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
