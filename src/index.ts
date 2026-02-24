import type { AntseedRouterPlugin } from '@antseed/node';
import { WELL_KNOWN_TOOL_HINTS, formatToolHints } from '@antseed/router-core';
import { LocalProxyRouter, type BuyerMaxPricingConfig } from './router.js';

function parseCsvProviders(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseMaxPricingJson(raw: string | undefined): BuyerMaxPricingConfig | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('ANTSEED_MAX_PRICING_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANTSEED_MAX_PRICING_JSON must be an object');
  }

  const root = parsed as Record<string, unknown>;
  const defaults = root['defaults'];
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('ANTSEED_MAX_PRICING_JSON.defaults must be an object');
  }

  const input = (defaults as Record<string, unknown>)['inputUsdPerMillion'];
  const output = (defaults as Record<string, unknown>)['outputUsdPerMillion'];
  if (!isNonNegativeFinite(input) || !isNonNegativeFinite(output)) {
    throw new Error('ANTSEED_MAX_PRICING_JSON.defaults must include non-negative inputUsdPerMillion/outputUsdPerMillion');
  }

  const result: BuyerMaxPricingConfig = {
    defaults: {
      inputUsdPerMillion: input,
      outputUsdPerMillion: output,
    },
  };

  const providersRaw = root['providers'];
  if (providersRaw !== undefined) {
    if (!providersRaw || typeof providersRaw !== 'object' || Array.isArray(providersRaw)) {
      throw new Error('ANTSEED_MAX_PRICING_JSON.providers must be an object');
    }

    const providersOut: NonNullable<BuyerMaxPricingConfig['providers']> = {};
    for (const [provider, rawProviderConfig] of Object.entries(providersRaw as Record<string, unknown>)) {
      if (!rawProviderConfig || typeof rawProviderConfig !== 'object' || Array.isArray(rawProviderConfig)) {
        throw new Error(`ANTSEED_MAX_PRICING_JSON.providers.${provider} must be an object`);
      }

      const providerObj = rawProviderConfig as Record<string, unknown>;
      const providerOut: NonNullable<BuyerMaxPricingConfig['providers']>[string] = {};

      const providerDefaults = providerObj['defaults'];
      if (providerDefaults !== undefined) {
        if (!providerDefaults || typeof providerDefaults !== 'object' || Array.isArray(providerDefaults)) {
          throw new Error(`ANTSEED_MAX_PRICING_JSON.providers.${provider}.defaults must be an object`);
        }
        const providerInput = (providerDefaults as Record<string, unknown>)['inputUsdPerMillion'];
        const providerOutput = (providerDefaults as Record<string, unknown>)['outputUsdPerMillion'];
        if (!isNonNegativeFinite(providerInput) || !isNonNegativeFinite(providerOutput)) {
          throw new Error(`ANTSEED_MAX_PRICING_JSON.providers.${provider}.defaults must include non-negative inputUsdPerMillion/outputUsdPerMillion`);
        }
        providerOut.defaults = {
          inputUsdPerMillion: providerInput,
          outputUsdPerMillion: providerOutput,
        };
      }

      const modelPricing = providerObj['models'];
      if (modelPricing !== undefined) {
        if (!modelPricing || typeof modelPricing !== 'object' || Array.isArray(modelPricing)) {
          throw new Error(`ANTSEED_MAX_PRICING_JSON.providers.${provider}.models must be an object`);
        }

        const modelsOut: NonNullable<BuyerMaxPricingConfig['providers']>[string]['models'] = {};
        for (const [model, modelPricingRaw] of Object.entries(modelPricing as Record<string, unknown>)) {
          if (!modelPricingRaw || typeof modelPricingRaw !== 'object' || Array.isArray(modelPricingRaw)) {
            throw new Error(`ANTSEED_MAX_PRICING_JSON.providers.${provider}.models.${model} must be an object`);
          }
          const modelInput = (modelPricingRaw as Record<string, unknown>)['inputUsdPerMillion'];
          const modelOutput = (modelPricingRaw as Record<string, unknown>)['outputUsdPerMillion'];
          if (!isNonNegativeFinite(modelInput) || !isNonNegativeFinite(modelOutput)) {
            throw new Error(`ANTSEED_MAX_PRICING_JSON.providers.${provider}.models.${model} must include non-negative inputUsdPerMillion/outputUsdPerMillion`);
          }
          modelsOut[model] = {
            inputUsdPerMillion: modelInput,
            outputUsdPerMillion: modelOutput,
          };
        }

        if (Object.keys(modelsOut).length > 0) {
          providerOut.models = modelsOut;
        }
      }

      providersOut[provider] = providerOut;
    }

    if (Object.keys(providersOut).length > 0) {
      result.providers = providersOut;
    }
  }

  return result;
}

const plugin: AntseedRouterPlugin = {
  name: 'local-proxy',
  displayName: 'Local Proxy',
  version: '0.1.0',
  type: 'router',
  description: 'Local proxy router for Claude Code, Aider, Continue.dev, OpenAI Codex',
  configSchema: [
    { key: 'ANTSEED_MIN_REPUTATION', label: 'Min Reputation', type: 'number', required: false, default: 50, description: 'Min peer reputation 0-100' },
    { key: 'ANTSEED_PREFERRED_PROVIDERS', label: 'Preferred Providers', type: 'string[]', required: false, description: 'Ordered preferred providers' },
    { key: 'ANTSEED_MAX_PRICING_JSON', label: 'Max Pricing JSON', type: 'string', required: false, description: 'Buyer max pricing JSON' },
    { key: 'ANTSEED_MAX_FAILURES', label: 'Max Failures', type: 'number', required: false, default: 3, description: 'Max consecutive failures before excluding peer' },
    { key: 'ANTSEED_FAILURE_COOLDOWN_MS', label: 'Failure Cooldown (ms)', type: 'number', required: false, default: 30000, description: 'Cooldown after repeated failures (ms)' },
    { key: 'ANTSEED_MAX_PEER_STALENESS_MS', label: 'Max Peer Staleness (ms)', type: 'number', required: false, default: 300000, description: 'Peer staleness horizon (ms)' },
  ],
  createRouter(config: Record<string, string>) {
    const minReputation = config['ANTSEED_MIN_REPUTATION'] ? parseInt(config['ANTSEED_MIN_REPUTATION'], 10) : undefined;
    if (minReputation !== undefined && Number.isNaN(minReputation)) {
      throw new Error('ANTSEED_MIN_REPUTATION must be a valid number');
    }
    const preferredProviders = parseCsvProviders(config['ANTSEED_PREFERRED_PROVIDERS']);
    const maxPricing = parseMaxPricingJson(config['ANTSEED_MAX_PRICING_JSON']);
    const maxFailures = config['ANTSEED_MAX_FAILURES'] ? parseInt(config['ANTSEED_MAX_FAILURES'], 10) : undefined;
    if (maxFailures !== undefined && Number.isNaN(maxFailures)) {
      throw new Error('ANTSEED_MAX_FAILURES must be a valid number');
    }
    const failureCooldownMs = config['ANTSEED_FAILURE_COOLDOWN_MS'] ? parseInt(config['ANTSEED_FAILURE_COOLDOWN_MS'], 10) : undefined;
    if (failureCooldownMs !== undefined && Number.isNaN(failureCooldownMs)) {
      throw new Error('ANTSEED_FAILURE_COOLDOWN_MS must be a valid number');
    }
    const maxPeerStalenessMs = config['ANTSEED_MAX_PEER_STALENESS_MS'] ? parseInt(config['ANTSEED_MAX_PEER_STALENESS_MS'], 10) : undefined;
    if (maxPeerStalenessMs !== undefined && Number.isNaN(maxPeerStalenessMs)) {
      throw new Error('ANTSEED_MAX_PEER_STALENESS_MS must be a valid number');
    }
    return new LocalProxyRouter({
      preferredProviders,
      minReputation,
      maxPricing,
      maxFailures,
      failureCooldownMs,
      maxPeerStalenessMs,
    });
  },
};

export default plugin;

export const TOOL_HINTS = WELL_KNOWN_TOOL_HINTS;
export { formatToolHints };
