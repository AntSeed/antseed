import { describe, expect, it } from 'vitest';
import { areRouteRecommendationsEligible, isRouteRecommendation, isRouteRecommendationEligible } from '../src/routing/route-recommendation.js';

const candidates = [
  { serviceId: 'model-x', peerId: 'seller-a' },
  { serviceId: 'model-x', peerId: 'seller-b' },
  { serviceId: 'model-y', peerId: 'seller-c' },
];

describe('router recommendation validation', () => {
  it('requires an eligible offer supporting the chosen effort, without allowing arbitrary overrides', () => {
    const offers = [{ serviceId: 'model', peerId: 'one', reasoningEfforts: ['high' as const] }, { serviceId: 'model', peerId: 'two' }];
    const route = { serviceId: 'model', inference: { reasoningEffort: 'high' } };
    expect(areRouteRecommendationsEligible([route], offers)).toBe(true);
    expect(areRouteRecommendationsEligible([{ ...route, peerId: 'two' }], offers)).toBe(false);
    for (const inference of [{}, null, { reasoningEffort: 'unknown' }, { reasoningEffort: 'low' }, { reasoningEffort: 'high', max_tokens: 9000 }]) {
      expect(areRouteRecommendationsEligible([{ ...route, inference }], offers)).toBe(false);
    }
    expect(areRouteRecommendationsEligible([{ ...route, inference: undefined }], offers)).toBe(true);
  });
  it('accepts ordered model-only and exact recommendations across models', () => {
    expect(areRouteRecommendationsEligible([
      { serviceId: 'model-y', peerId: 'seller-c' },
      { serviceId: 'model-x' },
      { serviceId: 'model-x', peerId: 'seller-a' },
    ], candidates)).toBe(true);
  });

  it.each([
    null, {}, [], Array(1),
    [{ serviceId: 'model-x' }, { serviceId: 'model-x' }],
    [{ serviceId: 'model-x', peerId: 'seller-a' }, { serviceId: 'model-x', peerId: 'seller-a' }],
    [{ serviceId: 'model-x' }, { serviceId: 'unknown' }],
    [{ serviceId: 'model-x', peerId: 'seller-c' }],
    [{ serviceId: 'model-x', price: 0 }],
    Array.from({ length: 6 }, () => ({ serviceId: 'model-x' })),
  ])('rejects invalid ranked lists %j', (routes) => {
    expect(areRouteRecommendationsEligible(routes, candidates)).toBe(false);
  });

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
