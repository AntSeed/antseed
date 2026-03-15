import type { AntseedProviderPlugin, Provider, ServiceApiProtocol } from '@antseed/node';
import { BaseProvider, StaticTokenProvider, parseServiceAliasMap as parseGenericAliasMap } from '@antseed/provider-core';

const SPECIAL_OPENAI_COMPAT_PROVIDERS = ['openrouter'] as const;
type OpenAiCompatFlavor = 'generic' | (typeof SPECIAL_OPENAI_COMPAT_PROVIDERS)[number];

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

function parseServiceAliasMap(raw: string | undefined): Record<string, string> | undefined {
  const parsed = parseJsonObject(raw, 'OPENAI_SERVICE_ALIAS_MAP_JSON');
  if (!parsed) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [announcedServiceRaw, upstreamServiceRaw] of Object.entries(parsed)) {
    const announcedService = announcedServiceRaw.trim().toLowerCase();
    if (!announcedService) {
      continue;
    }
    if (typeof upstreamServiceRaw !== 'string' || upstreamServiceRaw.trim().length === 0) {
      throw new Error(`OPENAI_SERVICE_ALIAS_MAP_JSON entry "${announcedServiceRaw}" must map to a non-empty string`);
    }
    out[announcedService] = upstreamServiceRaw.trim();
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeServicePrefix(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function buildServiceRewriteMap(
  announcedServices: string[],
  upstreamServicePrefixRaw: string | undefined,
  serviceAliasMap: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const upstreamServicePrefix = normalizeServicePrefix(upstreamServicePrefixRaw);

  if (upstreamServicePrefix) {
    const normalizedPrefix = upstreamServicePrefix.toLowerCase();
    for (const service of announcedServices) {
      const announced = service.trim();
      if (!announced) {
        continue;
      }
      const normalizedAnnounced = announced.toLowerCase();
      const hasPrefix = normalizedAnnounced.startsWith(normalizedPrefix);
      out[announced.toLowerCase()] = hasPrefix
        ? announced
        : `${upstreamServicePrefix}${announced}`;
    }
  }

  if (serviceAliasMap) {
    for (const [announcedService, upstreamService] of Object.entries(serviceAliasMap)) {
      out[announcedService] = upstreamService;
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

function buildServiceApiProtocols(
  services: string[],
  protocol: ServiceApiProtocol,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) return undefined;
  return Object.fromEntries(services.map((service) => [service, [protocol]]));
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
    { key: 'OPENAI_UPSTREAM_SERVICE_PREFIX', label: 'Upstream Service Prefix', type: 'string', required: false, description: 'Optional prefix prepended to announced service names when forwarding upstream (e.g. together/)' },
    { key: 'OPENAI_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map JSON', type: 'string', required: false, description: 'Optional JSON map of announcedService -> upstreamService' },
    { key: 'OPENAI_EXTRA_HEADERS_JSON', label: 'Extra Headers JSON', type: 'string', required: false, description: 'Optional JSON object of extra headers' },
    { key: 'OPENAI_BODY_INJECT_JSON', label: 'Body Inject JSON', type: 'string', required: false, description: 'Optional JSON object merged into request body' },
    { key: 'OPENAI_STRIP_HEADER_PREFIXES', label: 'Strip Header Prefixes', type: 'string[]', required: false, description: 'Comma-separated header prefixes to strip before relay' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 10, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list' },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service → upstream model name (generic, works across all providers)' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const apiKey = config['OPENAI_API_KEY']?.trim() ?? '';
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required');
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

    const allowedServices = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
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
    const serviceApiProtocols = buildServiceApiProtocols(allowedServices, 'openai-chat-completions');
    // Merge alias maps: generic ANTSEED_SERVICE_ALIAS_MAP_JSON (base) + OpenAI-specific (overrides)
    const genericAliasMap = parseGenericAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const openaiAliasMap = parseServiceAliasMap(config['OPENAI_SERVICE_ALIAS_MAP_JSON']);
    const mergedAliasMap = genericAliasMap || openaiAliasMap
      ? { ...genericAliasMap, ...openaiAliasMap }
      : undefined;
    const serviceRewriteMap = buildServiceRewriteMap(
      allowedServices,
      config['OPENAI_UPSTREAM_SERVICE_PREFIX'],
      mergedAliasMap,
    );

    return new BaseProvider({
      name: 'openai',
      services: allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      relay: {
        baseUrl,
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
        tokenProvider,
        maxConcurrency,
        allowedServices,
        ...(serviceRewriteMap ? { serviceRewriteMap } : {}),
        ...(effectiveStripHeaderPrefixes.length > 0 ? { stripHeaderPrefixes: effectiveStripHeaderPrefixes } : {}),
        ...(Object.keys(bodyInject).length > 0 ? { injectJsonFields: bodyInject } : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
      },
    });
  },
};

export default plugin;
