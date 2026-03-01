import type { AntseedProviderPlugin, Provider, ModelApiProtocol } from '@antseed/node';
import { BaseProvider, StaticTokenProvider } from '@antseed/provider-core';

const SPECIAL_OPENAI_COMPAT_PROVIDERS = ['openrouter'] as const;
type OpenAiCompatFlavor = 'generic' | (typeof SPECIAL_OPENAI_COMPAT_PROVIDERS)[number];

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

function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

function parseJsonObject(raw: string | undefined, key: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseModelAliasMap(raw: string | undefined): Record<string, string> | undefined {
  const parsed = parseJsonObject(raw, 'OPENAI_MODEL_ALIAS_MAP_JSON');
  if (!parsed) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [announcedModelRaw, upstreamModelRaw] of Object.entries(parsed)) {
    const announcedModel = announcedModelRaw.trim().toLowerCase();
    if (!announcedModel) {
      continue;
    }
    if (typeof upstreamModelRaw !== 'string' || upstreamModelRaw.trim().length === 0) {
      throw new Error(`OPENAI_MODEL_ALIAS_MAP_JSON entry "${announcedModelRaw}" must map to a non-empty string`);
    }
    out[announcedModel] = upstreamModelRaw.trim();
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeModelPrefix(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function buildModelRewriteMap(
  announcedModels: string[],
  upstreamModelPrefixRaw: string | undefined,
  modelAliasMap: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const upstreamModelPrefix = normalizeModelPrefix(upstreamModelPrefixRaw);

  if (upstreamModelPrefix) {
    const normalizedPrefix = upstreamModelPrefix.toLowerCase();
    for (const model of announcedModels) {
      const announced = model.trim();
      if (!announced) {
        continue;
      }
      const normalizedAnnounced = announced.toLowerCase();
      const hasPrefix = normalizedAnnounced.startsWith(normalizedPrefix);
      out[announced.toLowerCase()] = hasPrefix
        ? announced
        : `${upstreamModelPrefix}${announced}`;
    }
  }

  if (modelAliasMap) {
    for (const [announcedModel, upstreamModel] of Object.entries(modelAliasMap)) {
      out[announcedModel] = upstreamModel;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseExtraHeaders(raw: string | undefined): Record<string, string> | undefined {
  const parsed = parseJsonObject(raw, 'OPENAI_EXTRA_HEADERS_JSON');
  if (!parsed) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const header = key.trim();
    if (!header) continue;
    if (typeof value === 'string') {
      out[header] = value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[header] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveFlavor(configFlavor: string | undefined, baseUrl: string | undefined): OpenAiCompatFlavor {
  const flavor = configFlavor?.trim().toLowerCase();
  if (flavor === 'openrouter') {
    return 'openrouter';
  }

  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      if (host.includes('openrouter.ai')) {
        return 'openrouter';
      }
    } catch {
      if (baseUrl.toLowerCase().includes('openrouter.ai')) {
        return 'openrouter';
      }
    }
  }

  return 'generic';
}

function buildModelApiProtocols(
  models: string[],
  protocol: ModelApiProtocol,
): Record<string, ModelApiProtocol[]> | undefined {
  if (models.length === 0) return undefined;
  return Object.fromEntries(models.map((model) => [model, [protocol]]));
}

const plugin: AntseedProviderPlugin = {
  name: 'openai',
  displayName: 'OpenAI-Compatible',
  version: '0.1.0',
  type: 'provider',
  description: 'Provide OpenAI-compatible API capacity (OpenAI, Together, OpenRouter, and similar)',
  configSchema: [
    { key: 'OPENAI_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'OpenAI-compatible upstream API key' },
    { key: 'OPENAI_BASE_URL', label: 'Base URL', type: 'string', required: false, default: 'https://api.openai.com', description: 'OpenAI-compatible base URL' },
    { key: 'OPENAI_PROVIDER_FLAVOR', label: 'Provider Flavor', type: 'string', required: false, default: 'generic', description: 'Special handling profile: generic | openrouter' },
    { key: 'OPENAI_UPSTREAM_PROVIDER', label: 'Upstream Provider', type: 'string', required: false, description: 'Optional OpenRouter provider selector value' },
    { key: 'OPENAI_UPSTREAM_MODEL_PREFIX', label: 'Upstream Model Prefix', type: 'string', required: false, description: 'Optional prefix prepended to announced model names when forwarding upstream (e.g. together/)' },
    { key: 'OPENAI_MODEL_ALIAS_MAP_JSON', label: 'Model Alias Map JSON', type: 'string', required: false, description: 'Optional JSON map of announcedModel -> upstreamModel' },
    { key: 'OPENAI_EXTRA_HEADERS_JSON', label: 'Extra Headers JSON', type: 'string', required: false, description: 'Optional JSON object of extra headers' },
    { key: 'OPENAI_BODY_INJECT_JSON', label: 'Body Inject JSON', type: 'string', required: false, description: 'Optional JSON object merged into request body' },
    { key: 'OPENAI_STRIP_HEADER_PREFIXES', label: 'Strip Header Prefixes', type: 'string[]', required: false, description: 'Comma-separated header prefixes to strip before relay' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_MODEL_PRICING_JSON', label: 'Model Pricing JSON', type: 'string', required: false, description: 'Per-model pricing JSON' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 10, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_MODELS', label: 'Allowed Models', type: 'string[]', required: false, description: 'Model allow-list' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const apiKey = config['OPENAI_API_KEY']?.trim() ?? '';
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required');
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

    const allowedModels = parseCsv(config['ANTSEED_ALLOWED_MODELS']);
    const configuredBaseUrl = config['OPENAI_BASE_URL']?.trim();
    const flavor = resolveFlavor(config['OPENAI_PROVIDER_FLAVOR'], configuredBaseUrl);
    const baseUrl = configuredBaseUrl && configuredBaseUrl.length > 0
      ? configuredBaseUrl
      : (flavor === 'openrouter' ? 'https://openrouter.ai/api' : 'https://api.openai.com');
    const upstreamProvider = config['OPENAI_UPSTREAM_PROVIDER']?.trim();
    const bodyInject = parseJsonObject(config['OPENAI_BODY_INJECT_JSON'], 'OPENAI_BODY_INJECT_JSON') ?? {};
    if (flavor === 'openrouter' && upstreamProvider) {
      bodyInject['provider'] = { only: [upstreamProvider] };
    }
    const extraHeaders = parseExtraHeaders(config['OPENAI_EXTRA_HEADERS_JSON']);
    const stripHeaderPrefixes = parseCsv(config['OPENAI_STRIP_HEADER_PREFIXES']).map((entry) => entry.toLowerCase());
    const effectiveStripHeaderPrefixes = stripHeaderPrefixes.length > 0
      ? stripHeaderPrefixes
      : (flavor === 'openrouter' ? ['anthropic-', 'x-stainless-'] : []);

    const tokenProvider = new StaticTokenProvider(apiKey);
    const modelApiProtocols = buildModelApiProtocols(allowedModels, 'openai-chat-completions');
    const modelAliasMap = parseModelAliasMap(config['OPENAI_MODEL_ALIAS_MAP_JSON']);
    const modelRewriteMap = buildModelRewriteMap(
      allowedModels,
      config['OPENAI_UPSTREAM_MODEL_PREFIX'],
      modelAliasMap,
    );

    return new BaseProvider({
      name: 'openai',
      models: allowedModels,
      pricing,
      ...(modelApiProtocols ? { modelApiProtocols } : {}),
      relay: {
        baseUrl,
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
        tokenProvider,
        maxConcurrency,
        allowedModels,
        ...(modelRewriteMap ? { modelRewriteMap } : {}),
        ...(effectiveStripHeaderPrefixes.length > 0 ? { stripHeaderPrefixes: effectiveStripHeaderPrefixes } : {}),
        ...(Object.keys(bodyInject).length > 0 ? { injectJsonFields: bodyInject } : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
      },
    });
  },
};

export default plugin;
