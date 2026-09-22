import type { AntseedProviderPlugin, Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import { fixedFeeOffering } from '@antseed/node';
import { BaseProvider } from '@antseed/provider-core';
import { LEVANTO_ROUTING_CONTRACT, LEVANTO_ROUTING_PATH, validateFixedFeeRequest, validateFixedFeeResponse } from './contract.js';

class LevantoProvider extends BaseProvider {
  override async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    if (request.method !== 'POST' || request.path !== LEVANTO_ROUTING_PATH) throw new Error('Expected POST /_antseed/route');
    const body: unknown = JSON.parse(new TextDecoder().decode(request.body));
    validateFixedFeeRequest(LEVANTO_ROUTING_CONTRACT, body);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !key.toLowerCase().startsWith('x-antseed-')));
    const response = await super.handleRequest({ ...request, headers });
    if (response.statusCode >= 200 && response.statusCode < 300) {
      validateFixedFeeResponse(LEVANTO_ROUTING_CONTRACT, JSON.parse(new TextDecoder().decode(response.body)), body);
    }
    return response;
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'levanto', displayName: 'Levanto', version: '0.1.0', type: 'provider',
  description: 'Provide Levanto routing recommendations with a fixed fee per fulfilled response',
  configSchema: [
    { key: 'LEVANTO_BASE_URL', label: 'Upstream URL', type: 'string', required: true },
    { key: 'LEVANTO_API_KEY', label: 'Upstream API Key', type: 'secret', required: true },
    { key: 'ANTSEED_REQUEST_PRICE_MICRO_USDC', label: 'Price per response (micro-USDC)', type: 'string', required: true },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', default: 10 },
  ],
  createProvider(config): Provider {
    const baseUrl = config.LEVANTO_BASE_URL?.trim();
    const apiKey = config.LEVANTO_API_KEY?.trim();
    if (!baseUrl) throw new Error('LEVANTO_BASE_URL is required');
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid LEVANTO_BASE_URL');
    if (!apiKey) throw new Error('LEVANTO_API_KEY is required');
    const priceMicroUsdc = config.ANTSEED_REQUEST_PRICE_MICRO_USDC;
    if (priceMicroUsdc === undefined) throw new Error('ANTSEED_REQUEST_PRICE_MICRO_USDC is required');
    const offer = { provider: 'levanto', service: 'levanto-route', contract: LEVANTO_ROUTING_CONTRACT, priceMicroUsdc };
    fixedFeeOffering(offer);
    const maxConcurrency = Number(config.ANTSEED_MAX_CONCURRENCY ?? 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    return new LevantoProvider({
      name: 'levanto', services: [offer.service], fixedFeeServices: [{ ...offer, path: LEVANTO_ROUTING_PATH }],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      relay: { baseUrl, authHeaderName: 'authorization', authHeaderValue: `Bearer ${apiKey}`,
        maxConcurrency, allowedServices: [offer.service], preserveServicePayload: true },
    });
  },
};

export default plugin;
export { routerPlugin } from './router.js';
