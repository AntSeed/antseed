import { describe, expect, it } from 'vitest';
import { createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingRequest, type RouteSelectionContext, type RoutingPreferenceSchema } from '@antseed/node';
import { parseRoutingResponse, selectNetworkRoute } from './network-router.js';
import { provider as referenceProvider, metadata as referenceMetadata } from '../../../docs/protocol/templates/routing-provider/src/index.js';

const candidates = [{ serviceId: 'model-a', peerId: 'a'.repeat(40), inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, { serviceId: 'model-b', peerId: 'b'.repeat(40), inputUsdPerMillion: 3, outputUsdPerMillion: 4 }];
const request = { requestId: 'parent', method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'secret' }, body: new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })) };
const response = (value: unknown) => ({ requestId: 'routing', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });

describe('network routing', () => {
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
          return response({ version: 1, recommendation: { serviceId: candidates[index]!.serviceId } });
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
  it.each([{ version: 1, recommendation: { serviceId: 'missing' } }, { version: 1, recommendation: { serviceId: 'model-a', peerId: candidates[1]!.peerId } }, { choices: [{ message: { content: '{}' } }] }, { version: 1, recommendations: [] }, { version: 2, recommendation: { serviceId: 'model-a' } }])('rejects invalid responses', (value) => {
    expect(() => parseRoutingResponse(response(value), candidates)).toThrow();
  });
  it('rejects malformed usage rather than accepting a billable response', () => {
    expect(() => parseRoutingResponse(response({ version: 1, recommendation: { serviceId: 'model-a' }, usage: { input_tokens: -1, output_tokens: 1 } }), candidates)).toThrow('usage');
  });
});
