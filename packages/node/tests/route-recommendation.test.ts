import { describe, expect, it } from 'vitest';
import { isRouteRecommendation, isRouteRecommendationEligible } from '../src/routing/route-recommendation.js';

const candidates = [
  { serviceId: 'model-x', peerId: 'seller-a' },
  { serviceId: 'model-x', peerId: 'seller-b' },
  { serviceId: 'model-y', peerId: 'seller-c' },
];

describe('router recommendation validation', () => {
  it('accepts a model-only recommendation only if an eligible seller offers it', () => {
    expect(isRouteRecommendationEligible({ serviceId: 'model-x' }, candidates)).toBe(true);
    expect(isRouteRecommendationEligible({ serviceId: 'model-x' }, [])).toBe(false);
    expect(isRouteRecommendationEligible({ serviceId: 'unknown' }, candidates)).toBe(false);
  });

  it('does not relax an explicit seller into automatic selection', () => {
    expect(isRouteRecommendationEligible({ serviceId: 'model-x', peerId: 'seller-b' }, candidates)).toBe(true);
    expect(isRouteRecommendationEligible({ serviceId: 'model-x', peerId: 'seller-c' }, candidates)).toBe(false);
  });

  it.each([null, [], {}, { serviceId: '' }, { serviceId: 1 }, { serviceId: 'model-x', peerId: null },
    { serviceId: 'model-x', peerId: '' }, { serviceId: 'model-x', peerId: 1 }])('rejects malformed selections %j', (value) => {
    expect(isRouteRecommendation(value)).toBe(false);
    expect(isRouteRecommendationEligible(value, candidates)).toBe(false);
  });
});
