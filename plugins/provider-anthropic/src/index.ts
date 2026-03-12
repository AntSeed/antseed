import type { AntseedProviderPlugin, Provider, ServiceApiProtocol } from '@antseed/node';
import { BaseProvider, StaticTokenProvider } from '@antseed/provider-core';

function parseNonNegativeNumber(raw: string | undefined, key: string, fallback: number): number {
  const parsed = raw === undefined ? fallback : Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

function parseServicePricingJson(raw: string | undefined): Provider['pricing']['services'] {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('ANTSEED_SERVICE_PRICING_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANTSEED_SERVICE_PRICING_JSON must be an object map of service -> pricing');
  }

  const out: NonNullable<Provider['pricing']['services']> = {};
  for (const [service, pricing] of Object.entries(parsed as Record<string, unknown>)) {
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
      throw new Error(`Service pricing for "${service}" must be an object`);
    }
    const input = (pricing as Record<string, unknown>)['inputUsdPerMillion'];
    const output = (pricing as Record<string, unknown>)['outputUsdPerMillion'];
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
      throw new Error(`Service pricing for "${service}" requires non-negative inputUsdPerMillion`);
    }
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      throw new Error(`Service pricing for "${service}" requires non-negative outputUsdPerMillion`);
    }
    out[service] = { inputUsdPerMillion: input, outputUsdPerMillion: output };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function buildServiceApiProtocols(
  services: string[],
  protocol: ServiceApiProtocol,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) return undefined;
  return Object.fromEntries(services.map((service) => [service, [protocol]]));
}

const plugin: AntseedProviderPlugin = {
  name: 'anthropic',
  displayName: 'Anthropic',
  version: '0.1.0',
  type: 'provider',
  description: 'Provide Anthropic API capacity using an API key',
  configSchema: [
    { key: 'ANTHROPIC_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'Anthropic API key' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 10, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const apiKey = config['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required');
    }

    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', 10),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', 10),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '10', 10);
    if (Number.isNaN(maxConcurrency)) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a valid number');
    }

    const allowedServices = config['ANTSEED_ALLOWED_SERVICES']
      ? config['ANTSEED_ALLOWED_SERVICES'].split(',').map((s: string) => s.trim())
      : [];

    const tokenProvider = new StaticTokenProvider(apiKey);
    const serviceApiProtocols = buildServiceApiProtocols(allowedServices, 'anthropic-messages');

    return new BaseProvider({
      name: 'anthropic',
      services: allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      relay: {
        baseUrl: 'https://api.anthropic.com',
        authHeaderName: 'x-api-key',
        authHeaderValue: '',
        tokenProvider,
        maxConcurrency,
        allowedServices,
      },
    });
  },
};

export default plugin;
