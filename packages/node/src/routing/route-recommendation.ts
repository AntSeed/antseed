import type { RouteRecommendation } from '../interfaces/buyer-router.js';

export function isRouteRecommendation(value: unknown): value is RouteRecommendation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return typeof route.serviceId === 'string' && route.serviceId.length > 0
    && (route.peerId === undefined || (typeof route.peerId === 'string' && route.peerId.length > 0));
}

export function isRouteRecommendationEligible(
  value: unknown,
  candidates: readonly { serviceId: string; peerId: string }[],
): value is RouteRecommendation {
  return isRouteRecommendation(value) && candidates.some((candidate) => candidate.serviceId === value.serviceId
    && (value.peerId === undefined || candidate.peerId === value.peerId));
}
