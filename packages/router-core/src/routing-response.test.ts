import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { validateRoutingRequest, type RoutingRequestV1, type RoutingServiceMetadataV1 } from '@antseed/node';
import { parseRoutingResponse } from './routing-response.js';
import { provider, metadata } from '../../../docs/protocol/templates/routing-provider/src/index.js';

const candidates = [{ serviceId: 'model-a', peerId: 'a'.repeat(40), inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, { serviceId: 'model-b', peerId: 'b'.repeat(40), inputUsdPerMillion: 3, outputUsdPerMillion: 4 }];
const response = (value: unknown) => ({ requestId: 'routing', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });

describe('routing response contract', () => {
  it('validates the documented fixtures without a standalone compatibility script', async () => {
    const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../../../docs/protocol/templates/routing-provider/fixtures/${name}.json`, import.meta.url), 'utf8'));
    const descriptor = await fixture('metadata') as RoutingServiceMetadataV1;
    const request = await fixture('request') as RoutingRequestV1;
    expect(() => validateRoutingRequest(request, descriptor)).not.toThrow();
    const valid = await fixture('response');
    expect(parseRoutingResponse(response(valid), request.candidates)).toEqual(valid.recommendations);
    const invalid = await fixture('invalid-response');
    expect(() => parseRoutingResponse(response(invalid), request.candidates)).toThrow();
  });
  it('accepts custom reasoning labels only when an eligible seller advertises them', () => {
    const recommendations = [{ serviceId: 'model-a', inference: { reasoningEffort: 'adaptive' } }];
    const offers = candidates.map((candidate) => ({ ...candidate, reasoningEfforts: ['adaptive'] }));
    expect(parseRoutingResponse(response({ version: 1, recommendations }), offers)).toEqual(recommendations);
    expect(() => parseRoutingResponse(response({ version: 1, recommendations }), candidates)).toThrow();
    expect(() => parseRoutingResponse(response({ version: 1, recommendations }), offers.map((offer) => ({ ...offer, reasoningEfforts: ['deep-analysis'] })))).toThrow();
  });
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
