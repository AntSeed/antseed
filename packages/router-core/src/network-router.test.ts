import { describe, expect, it } from 'vitest';
import { createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingRequest, type RouteSelectionContext, type RoutingPreferenceSchema } from '@antseed/node';
import { parseRoutingResponse, selectNetworkRoute } from './network-router.js';
import { provider as referenceProvider, metadata as referenceMetadata } from '../../../docs/protocol/templates/routing-provider/src/index.js';

const candidates = [{ serviceId: 'model-a', peerId: 'a'.repeat(40), inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, { serviceId: 'model-b', peerId: 'b'.repeat(40), inputUsdPerMillion: 3, outputUsdPerMillion: 4 }];
const request = { requestId: 'parent', method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'secret' }, body: new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })) };
const response = (value: unknown) => ({ requestId: 'routing', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });

describe('network routing', () => {
  it('forwards generic usage history separately from preferences without leaking local identifiers', async () => {
    const usageContext = { conversationRef: 'opaque', usageObservations: [{ id: 'observation-1', offer: { peerId: candidates[0]!.peerId, provider: 'example', serviceId: 'model-a' }, inputTokens: 100, ageMs: 10 }], historyTruncated: false };
    const context: RouteSelectionContext = {
      signal: new AbortController().signal, deadlineMs: Date.now() + 1000, candidates, usageContext,
      networkRouting: { serviceId: 'selector', metadata: referenceMetadata, preferences: {} },
      invokeService: async (input) => {
        validateRoutingRequest(input, referenceMetadata);
        expect(input.context).toEqual(usageContext);
        expect(input.context!.usageObservations[0]).not.toHaveProperty('cachedInputTokens');
        expect(JSON.stringify(input)).not.toContain('private-session');
        input.context!.usageObservations[0]!.inputTokens = 0;
        return response({ version: 1, recommendations: [{ serviceId: 'model-a' }] });
      },
    };
    await selectNetworkRoute(request, [], { tool: 'example', sessionKey: 'private-session', parentSessionKey: null, isUserThread: true }, null, null, context);
    expect(usageContext.usageObservations[0]!.inputTokens).toBe(100);
  });
  it('preserves router rank across model-only and exact seller recommendations', () => {
    const recommendations = [{ serviceId: 'model-b', peerId: candidates[1]!.peerId }, { serviceId: 'model-a' }];
    expect(parseRoutingResponse(response({ version: 1, recommendations }), candidates)).toEqual(recommendations);
  });

  it.each([
    { version: 1, recommendation: { serviceId: 'model-a' } },
    { version: 1, recommendations: null },
    { version: 1, recommendations: [{ serviceId: 'model-a' }, { serviceId: 'model-a' }] },
    { version: 1, recommendations: [{ serviceId: 'model-a' }, { serviceId: 'missing' }] },
    { version: 1, recommendations: [{ serviceId: 'model-a', extra: true }] },
    { version: 1, recommendations: Array.from({ length: 5 }, () => ({ serviceId: 'model-a' })) },
  ])('rejects ambiguous, duplicate or partially invalid lists', (value) => {
    expect(() => parseRoutingResponse(response(value), candidates)).toThrow();
  });

  it('reuses all remaining eligible recommendations in order without another paid call', async () => {
    const previousRoutes = [{ serviceId: 'gone' }, { serviceId: 'model-b', peerId: candidates[1]!.peerId }, { serviceId: 'model-a' }];
    const context: RouteSelectionContext = {
      signal: new AbortController().signal, deadlineMs: Date.now() + 1000, candidates,
      networkRouting: { serviceId: 'selector', metadata: referenceMetadata, preferences: {} },
      routing: { shouldRoute: false, trigger: 'continuation', previousRoute: previousRoutes[0]!, previousRoutes },
      invokeService: async () => { throw new Error('Unexpected paid call'); },
    };
    expect(await selectNetworkRoute(request, [], null, null, null, context)).toEqual(previousRoutes.slice(1));
  });

  it('calls two differently configured services without service-specific adapter logic', async () => {
    const schemas: RoutingPreferenceSchema[] = [
      { type: 'object', additionalProperties: false, properties: { chooseLast: { type: 'boolean', default: true } } },
      { type: 'object', additionalProperties: false, properties: { options: { type: 'object', additionalProperties: false, properties: { index: { type: 'integer', default: 0 } }, default: {} } } },
    ];
    for (const [index, schema] of schemas.entries()) {
      const metadata = createRoutingServiceMetadata(schema);
      const preferences = resolveRoutingPreferences(schema, {});
      const context: RouteSelectionContext = { signal: new AbortController().signal, deadlineMs: Date.now() + 1000, candidates,
        networkRouting: { serviceId: `selector-${index}`, metadata, preferences },
        invokeService: async (input) => {
          validateRoutingRequest(input, metadata);
          expect(input.preferences).toEqual(preferences);
          expect(JSON.stringify(input)).not.toContain('secret');
          return response({ version: 1, recommendations: [{ serviceId: candidates[index]!.serviceId }] });
        },
      };
      expect(await selectNetworkRoute(request, [], null, null, null, context)).toEqual([{ serviceId: candidates[index]!.serviceId }]);
    }
  });
  it('works with the reference provider and advertised defaults', async () => {
    const context: RouteSelectionContext = { signal: new AbortController().signal, deadlineMs: Date.now() + 1000, candidates,
      networkRouting: { serviceId: 'selector', metadata: referenceMetadata, preferences: { position: 'last' } },
      invokeService: async (input) => referenceProvider.handleRequest({ ...request, path: '/v1/route', body: new TextEncoder().encode(JSON.stringify(input)) }),
    };
    expect(await selectNetworkRoute(request, [], null, null, null, context)).toEqual([{ serviceId: 'model-b', peerId: candidates[1]!.peerId }]);
  });
  it.each([{ version: 1, recommendations: [{ serviceId: 'missing' }] }, { version: 1, recommendations: [{ serviceId: 'model-a', peerId: candidates[1]!.peerId }] }, { choices: [{ message: { content: '{}' } }] }, { version: 1, recommendations: [] }, { version: 2, recommendations: [{ serviceId: 'model-a' }] }])('rejects invalid responses', (value) => {
    expect(() => parseRoutingResponse(response(value), candidates)).toThrow();
  });
  it('rejects malformed usage rather than accepting a billable response', () => {
    expect(() => parseRoutingResponse(response({ version: 1, recommendations: [{ serviceId: 'model-a' }], usage: { input_tokens: -1, output_tokens: 1 } }), candidates)).toThrow('usage');
  });
});
