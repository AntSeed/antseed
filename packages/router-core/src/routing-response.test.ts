import { describe, expect, it } from 'vitest';
import { parseRoutingResponse } from './routing-response.js';
import { provider, metadata } from '../../../docs/protocol/templates/routing-provider/src/index.js';

const candidates = [{ serviceId: 'model-a', peerId: 'a'.repeat(40), inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, { serviceId: 'model-b', peerId: 'b'.repeat(40), inputUsdPerMillion: 3, outputUsdPerMillion: 4 }];
const response = (value: unknown) => ({ requestId: 'routing', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });

describe('routing response contract', () => {
  it.each([{}, { position: 'first' }, { position: 'last' }])('accepts the reference provider with preferences %j without a buyer adapter', async (preferences) => {
    const response = await provider.handleRequest({
      requestId: 'conformance', method: 'POST', path: '/v1/route', headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        version: 1, service: 'selector', preferencesSchemaHash: metadata.preferencesSchemaHash,
        request: { path: '/v1/messages', body: { messages: [] } }, candidates, preferences,
      })),
    });
    const candidate = preferences.position === 'last' ? candidates[1]! : candidates[0]!;
    expect(parseRoutingResponse(response, candidates)).toEqual([{ serviceId: candidate.serviceId, peerId: candidate.peerId }]);
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

  it.each([{ version: 1, recommendations: [{ serviceId: 'missing' }] }, { version: 1, recommendations: [{ serviceId: 'model-a', peerId: candidates[1]!.peerId }] }, { choices: [{ message: { content: '{}' } }] }, { version: 1, recommendations: [] }, { version: 2, recommendations: [{ serviceId: 'model-a' }] }])('rejects invalid responses', (value) => {
    expect(() => parseRoutingResponse(response(value), candidates)).toThrow();
  });
  it('rejects malformed usage rather than accepting a billable response', () => {
    expect(() => parseRoutingResponse(response({ version: 1, recommendations: [{ serviceId: 'model-a' }], usage: { input_tokens: -1, output_tokens: 1 } }), candidates)).toThrow('usage');
  });
});
