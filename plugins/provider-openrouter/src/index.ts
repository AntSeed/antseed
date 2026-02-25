import type { AntseedProviderPlugin, Provider } from '@antseed/node';
import { BaseProvider, StaticTokenProvider } from '@antseed/provider-core';

function parseNonNegativeNumber(raw: string | undefined, key: string, fallback: number): number {
  const parsed = raw === undefined ? fallback : Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

function parseModelPricingJson(raw: string | undefined): Provider['pricing']['models'] {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('ANTSEED_MODEL_PRICING_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANTSEED_MODEL_PRICING_JSON must be an object map of model -> pricing');
  }

  const out: NonNullable<Provider['pricing']['models']> = {};
  for (const [model, pricing] of Object.entries(parsed as Record<string, unknown>)) {
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
      throw new Error(`Model pricing for "${model}" must be an object`);
    }
    const input = (pricing as Record<string, unknown>)['inputUsdPerMillion'];
    const output = (pricing as Record<string, unknown>)['outputUsdPerMillion'];
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
      throw new Error(`Model pricing for "${model}" requires non-negative inputUsdPerMillion`);
    }
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      throw new Error(`Model pricing for "${model}" requires non-negative outputUsdPerMillion`);
    }
    out[model] = { inputUsdPerMillion: input, outputUsdPerMillion: output };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

const plugin: AntseedProviderPlugin = {
  name: 'openrouter',
  displayName: 'OpenRouter',
  version: '0.1.0',
  type: 'provider',
  description: 'Provide OpenRouter API capacity to P2P peers',
  configSchema: [
    { key: 'OPENROUTER_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'OpenRouter API key' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_MODEL_PRICING_JSON', label: 'Model Pricing JSON', type: 'string', required: false, description: 'Per-model pricing JSON' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 10, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_MODELS', label: 'Allowed Models', type: 'string[]', required: false, description: 'Model allow-list' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const apiKey = config['OPENROUTER_API_KEY'] ?? '';
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required');
    }

    const modelPricing = parseModelPricingJson(config['ANTSEED_MODEL_PRICING_JSON']);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', 10),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', 10),
      },
      ...(modelPricing ? { models: modelPricing } : {}),
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '10', 10);
    if (Number.isNaN(maxConcurrency)) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a valid number');
    }

    const allowedModels = config['ANTSEED_ALLOWED_MODELS']
      ? config['ANTSEED_ALLOWED_MODELS'].split(',').map((s: string) => s.trim())
      : [];

    const tokenProvider = new StaticTokenProvider(apiKey);

    return new BaseProvider({
      name: 'openrouter',
      models: allowedModels,
      pricing,
      relay: {
        baseUrl: 'https://openrouter.ai/api',
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
        tokenProvider,
        maxConcurrency,
        allowedModels,
      },
    });
  },
};

export default plugin;
