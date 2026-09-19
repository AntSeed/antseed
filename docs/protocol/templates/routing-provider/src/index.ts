import { createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingRequest, type AntseedProviderPlugin, type Provider } from '@antseed/node';

export const metadata = createRoutingServiceMetadata({
  type: 'object', additionalProperties: false,
  properties: { position: { type: 'string', enum: ['first', 'last'], default: 'first', description: 'Which eligible candidate to select' } },
});

export const provider: Provider = {
  name: 'example-router', services: ['selector'], maxConcurrency: 10,
  pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
  serviceApiProtocols: { selector: ['antseed-routing'] },
  serviceCapabilities: { selector: { routing: true } },
  serviceRouting: { selector: metadata },
  getCapacity: () => ({ current: 0, max: 10 }),
  async handleRequest(request) {
    try {
      if (request.path !== '/v1/route' || request.method !== 'POST') throw new Error('Expected POST /v1/route');
      const input: unknown = JSON.parse(new TextDecoder().decode(request.body));
      validateRoutingRequest(input, metadata);
      if (input.service !== 'selector') throw new Error('Unknown routing service');
      const preferences = resolveRoutingPreferences(metadata.preferencesSchema, input.preferences);
      const chosen = preferences.position === 'last' ? input.candidates.at(-1)! : input.candidates[0]!;
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ version: 1, recommendations: [{ serviceId: chosen.serviceId, peerId: chosen.peerId }] })) };
    } catch (error) {
      return { requestId: request.requestId, statusCode: 400, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ error: { code: 'invalid_routing_request', message: String(error) } })) };
    }
  },
};

const plugin: AntseedProviderPlugin = {
  name: 'example-router', version: '0.1.0', type: 'provider', description: 'Deterministic structured routing example', configSchema: [],
  createProvider: () => provider,
};
export default plugin;
