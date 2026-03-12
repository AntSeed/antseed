import type {
  AntseedProviderPlugin,
  Provider,
  ProviderStreamCallbacks,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ServiceApiProtocol,
} from '@antseed/node';
import { resolveProvider } from '@antseed/node';
import { BaseProvider, StaticTokenProvider } from '@antseed/provider-core';

type UpstreamKind = 'openai' | 'anthropic';
type OpenAiCompatFlavor = 'generic' | 'openrouter';

interface UnifiedUpstreamConfig {
  name: string;
  type: UpstreamKind;
  apiKey: string;
  allowedServices: string[];
  maxConcurrency?: number;
  pricing?: Provider['pricing'];
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  bodyInject?: Record<string, unknown>;
  stripHeaderPrefixes?: string[];
  serviceAliasMap?: Record<string, string>;
  upstreamServicePrefix?: string;
  providerFlavor?: OpenAiCompatFlavor;
  upstreamProvider?: string;
}

const plugin: AntseedProviderPlugin = {
  name: 'unified',
  displayName: 'Unified Provider',
  version: '0.1.0',
  type: 'provider',
  description: 'One provider plugin that can expose multiple upstreams and route services between them',
  configSchema: [
    {
      key: 'ANTSEED_UPSTREAMS_JSON',
      label: 'Upstreams JSON',
      type: 'secret',
      required: true,
      description: 'JSON array of upstream provider definitions with per-service routing',
    },
    {
      key: 'ANTSEED_DEFAULT_UPSTREAM',
      label: 'Default Upstream',
      type: 'string',
      required: false,
      description: 'Optional upstream name used when a request does not match a service-specific route',
    },
    {
      key: 'ANTSEED_PROVIDER_NAME',
      label: 'Provider Name',
      type: 'string',
      required: false,
      default: 'unified',
      description: 'Advertised provider name for discovery',
    },
  ],

  createProvider(config: Record<string, string>): Provider {
    const providerName = config['ANTSEED_PROVIDER_NAME']?.trim() || 'unified';
    const upstreams = parseUpstreams(config['ANTSEED_UPSTREAMS_JSON']);

    const routes = upstreams.map((upstream) => ({
      name: upstream.name,
      provider: createUpstreamProvider(upstream),
    }));

    return new UnifiedProvider({
      name: providerName,
      routes,
      defaultRoute: config['ANTSEED_DEFAULT_UPSTREAM']?.trim() || undefined,
    });
  },
};

export default plugin;

function createUpstreamProvider(config: UnifiedUpstreamConfig): Provider {
  const serviceApiProtocols = buildServiceApiProtocols(config.allowedServices, protocolFor(config.type));
  const pricing = config.pricing ?? {
    defaults: {
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 10,
    },
  };

  if (config.type === 'anthropic') {
    return new BaseProvider({
      name: config.name,
      services: config.allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      relay: {
        baseUrl: config.baseUrl?.trim() || 'https://api.anthropic.com',
        authHeaderName: 'x-api-key',
        authHeaderValue: '',
        tokenProvider: new StaticTokenProvider(config.apiKey),
        maxConcurrency: config.maxConcurrency ?? 10,
        allowedServices: config.allowedServices,
        ...(config.extraHeaders ? { extraHeaders: config.extraHeaders } : {}),
        ...(config.bodyInject ? { injectJsonFields: config.bodyInject } : {}),
        ...(config.stripHeaderPrefixes?.length ? { stripHeaderPrefixes: config.stripHeaderPrefixes } : {}),
      },
    });
  }

  const flavor = resolveFlavor(config.providerFlavor, config.baseUrl);
  const bodyInject = { ...(config.bodyInject ?? {}) };
  if (flavor === 'openrouter' && config.upstreamProvider) {
    bodyInject['provider'] = { only: [config.upstreamProvider] };
  }
  const stripHeaderPrefixes = config.stripHeaderPrefixes?.map((entry) => entry.toLowerCase())
    ?? (flavor === 'openrouter' ? ['anthropic-', 'x-stainless-'] : []);
  const serviceRewriteMap = buildServiceRewriteMap(
    config.allowedServices,
    config.upstreamServicePrefix,
    config.serviceAliasMap,
  );
  const baseUrl = config.baseUrl?.trim()
    || (flavor === 'openrouter' ? 'https://openrouter.ai/api' : 'https://api.openai.com');

  return new BaseProvider({
    name: config.name,
    services: config.allowedServices,
    pricing,
    ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
    relay: {
      baseUrl,
      authHeaderName: 'authorization',
      authHeaderValue: `Bearer ${config.apiKey}`,
      tokenProvider: new StaticTokenProvider(config.apiKey),
      maxConcurrency: config.maxConcurrency ?? 10,
      allowedServices: config.allowedServices,
      ...(config.extraHeaders ? { extraHeaders: config.extraHeaders } : {}),
      ...(Object.keys(bodyInject).length > 0 ? { injectJsonFields: bodyInject } : {}),
      ...(stripHeaderPrefixes.length > 0 ? { stripHeaderPrefixes } : {}),
      ...(serviceRewriteMap ? { serviceRewriteMap } : {}),
    },
  });
}

function parseUpstreams(raw: string | undefined): UnifiedUpstreamConfig[] {
  if (!raw) {
    throw new Error('ANTSEED_UPSTREAMS_JSON is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('ANTSEED_UPSTREAMS_JSON must be valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('ANTSEED_UPSTREAMS_JSON must be a non-empty array');
  }

  const seenNames = new Set<string>();
  return parsed.map((entry, index) => parseUpstream(entry, index, seenNames));
}

function parseUpstream(
  entry: unknown,
  index: number,
  seenNames: Set<string>,
): UnifiedUpstreamConfig {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Upstream at index ${index} must be an object`);
  }

  const raw = entry as Record<string, unknown>;
  const name = readNonEmptyString(raw['name'], `upstreams[${index}].name`);
  const normalizedName = name.toLowerCase();
  if (seenNames.has(normalizedName)) {
    throw new Error(`Duplicate upstream name "${name}"`);
  }
  seenNames.add(normalizedName);

  const type = readUpstreamKind(raw['type'], `upstreams[${index}].type`);
  const apiKey = readNonEmptyString(raw['apiKey'], `upstreams[${index}].apiKey`);
  const allowedServices = readStringArray(raw['allowedServices'], `upstreams[${index}].allowedServices`);
  if (allowedServices.length === 0) {
    throw new Error(`upstreams[${index}].allowedServices must contain at least one service`);
  }

  return {
    name,
    type,
    apiKey,
    allowedServices,
    maxConcurrency: readOptionalNonNegativeInteger(raw['maxConcurrency'], `upstreams[${index}].maxConcurrency`),
    pricing: parsePricing(raw['pricing'], `upstreams[${index}].pricing`),
    baseUrl: readOptionalString(raw['baseUrl']),
    extraHeaders: parseStringRecord(raw['extraHeaders'], `upstreams[${index}].extraHeaders`),
    bodyInject: parseJsonRecord(raw['bodyInject'], `upstreams[${index}].bodyInject`),
    stripHeaderPrefixes: readOptionalStringArray(raw['stripHeaderPrefixes'], `upstreams[${index}].stripHeaderPrefixes`),
    serviceAliasMap: parseStringRecord(raw['serviceAliasMap'], `upstreams[${index}].serviceAliasMap`),
    upstreamServicePrefix: readOptionalString(raw['upstreamServicePrefix']),
    providerFlavor: readOptionalFlavor(raw['providerFlavor'], `upstreams[${index}].providerFlavor`),
    upstreamProvider: readOptionalString(raw['upstreamProvider']),
  };
}

function protocolFor(type: UpstreamKind): ServiceApiProtocol {
  return type === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions';
}

function buildServiceApiProtocols(
  services: string[],
  protocol: ServiceApiProtocol,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) {
    return undefined;
  }
  return Object.fromEntries(services.map((service) => [service, [protocol]]));
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
      out[normalizedAnnounced] = normalizedAnnounced.startsWith(normalizedPrefix)
        ? announced
        : `${upstreamServicePrefix}${announced}`;
    }
  }

  if (serviceAliasMap) {
    for (const [announcedService, upstreamService] of Object.entries(serviceAliasMap)) {
      out[announcedService.trim().toLowerCase()] = upstreamService.trim();
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeServicePrefix(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function resolveFlavor(configFlavor: OpenAiCompatFlavor | undefined, baseUrl: string | undefined): OpenAiCompatFlavor {
  if (configFlavor === 'openrouter') {
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

function parsePricing(value: unknown, key: string): Provider['pricing'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }

  const raw = value as Record<string, unknown>;
  const defaults = raw['defaults'];
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error(`${key}.defaults is required`);
  }

  const pricing: Provider['pricing'] = {
    defaults: parsePricePair(defaults as Record<string, unknown>, `${key}.defaults`),
  };

  const services = raw['services'];
  if (services !== undefined) {
    if (!services || typeof services !== 'object' || Array.isArray(services)) {
      throw new Error(`${key}.services must be an object`);
    }
    pricing.services = Object.fromEntries(
      Object.entries(services as Record<string, unknown>).map(([service, servicePricing]) => {
        if (!servicePricing || typeof servicePricing !== 'object' || Array.isArray(servicePricing)) {
          throw new Error(`${key}.services.${service} must be an object`);
        }
        return [service, parsePricePair(servicePricing as Record<string, unknown>, `${key}.services.${service}`)];
      }),
    );
  }

  return pricing;
}

function parsePricePair(value: Record<string, unknown>, key: string): { inputUsdPerMillion: number; outputUsdPerMillion: number } {
  return {
    inputUsdPerMillion: readNonNegativeNumber(value['inputUsdPerMillion'], `${key}.inputUsdPerMillion`),
    outputUsdPerMillion: readNonNegativeNumber(value['outputUsdPerMillion'], `${key}.outputUsdPerMillion`),
  };
}

function parseStringRecord(value: unknown, key: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }

  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue !== 'string') {
      throw new Error(`${key}.${entryKey} must be a string`);
    }
    out[entryKey] = entryValue;
  }
  return out;
}

function parseJsonRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readUpstreamKind(value: unknown, key: string): UpstreamKind {
  if (value === 'openai' || value === 'anthropic') {
    return value;
  }
  throw new Error(`${key} must be "openai" or "anthropic"`);
}

function readOptionalFlavor(value: unknown, key: string): OpenAiCompatFlavor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'generic' || value === 'openrouter') {
    return value;
  }
  throw new Error(`${key} must be "generic" or "openrouter"`);
}

function readStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${key}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function readOptionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readStringArray(value, key);
}

function readNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNonNegativeInteger(value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function readNonNegativeNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

interface UnifiedProviderConfig {
  name: string;
  routes: Array<{
    name: string;
    provider: Provider;
  }>;
  defaultRoute?: string;
}

class UnifiedProvider implements Provider {
  readonly name: string;
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  readonly maxConcurrency: number;

  private readonly routes: RouteState[];
  private readonly routeByName: Map<string, RouteState>;
  private readonly routeByService: Map<string, RouteState>;
  private readonly defaultRoute: RouteState;

  constructor(config: UnifiedProviderConfig) {
    if (config.routes.length === 0) {
      throw new Error('Unified provider requires at least one upstream route');
    }

    this.name = config.name;
    this.routes = config.routes.map((route) => ({
      key: route.name.trim().toLowerCase(),
      provider: route.provider,
      services: new Set(route.provider.services.map((service) => service.trim().toLowerCase()).filter(Boolean)),
    }));
    this.routeByName = new Map(this.routes.map((route) => [route.key, route]));
    this.routeByService = new Map();

    for (const route of this.routes) {
      if (!route.key) {
        throw new Error('Unified provider route names cannot be empty');
      }
      for (const service of route.services) {
        if (!this.routeByService.has(service)) {
          this.routeByService.set(service, route);
        }
      }
    }

    const selectedDefault = config.defaultRoute?.trim().toLowerCase();
    this.defaultRoute = (selectedDefault ? this.routeByName.get(selectedDefault) : undefined) ?? this.routes[0]!;
    if (selectedDefault && !this.routeByName.has(selectedDefault)) {
      throw new Error(`Unknown default route "${config.defaultRoute}"`);
    }

    this.services = Array.from(new Set(this.routes.flatMap((route) => route.provider.services)));
    this.pricing = mergePricing(this.routes, this.defaultRoute);
    this.serviceApiProtocols = mergeServiceApiProtocols(this.routes);
    this.maxConcurrency = this.routes.reduce((sum, route) => sum + route.provider.maxConcurrency, 0);
  }

  async init(): Promise<void> {
    await Promise.all(this.routes.map(async (route) => route.provider.init?.()));
  }

  handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    return this.selectRoute(req).provider.handleRequest(req);
  }

  handleRequestStream(
    req: SerializedHttpRequest,
    callbacks: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse> {
    const provider = this.selectRoute(req).provider;
    if (provider.handleRequestStream) {
      return provider.handleRequestStream(req, callbacks);
    }
    return provider.handleRequest(req);
  }

  getCapacity(): { current: number; max: number } {
    return this.routes.reduce(
      (acc, route) => {
        const capacity = route.provider.getCapacity();
        acc.current += capacity.current;
        acc.max += capacity.max;
        return acc;
      },
      { current: 0, max: 0 },
    );
  }

  private selectRoute(req: SerializedHttpRequest): RouteState {
    const requestedService = extractRequestedService(req);
    if (requestedService) {
      const serviceRoute = this.routeByService.get(requestedService);
      if (serviceRoute) {
        return serviceRoute;
      }
    }

    const hinted = resolveProvider(req.path, req.headers, this.defaultRoute.key);
    return this.routeByName.get(hinted) ?? this.defaultRoute;
  }
}

interface RouteState {
  key: string;
  provider: Provider;
  services: Set<string>;
}

function extractRequestedService(req: SerializedHttpRequest): string | null {
  if (req.method === 'GET' || req.method === 'HEAD' || req.body.byteLength === 0) {
    return null;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
    const service = payload['service'] ?? payload['model'];
    if (typeof service !== 'string') {
      return null;
    }
    const normalized = service.trim().toLowerCase();
    return normalized || null;
  } catch {
    return null;
  }
}

function mergePricing(routes: RouteState[], defaultRoute: RouteState): Provider['pricing'] {
  const services: NonNullable<Provider['pricing']['services']> = {};

  for (const route of routes) {
    const explicitPricing = route.provider.pricing.services ?? {};
    for (const service of route.provider.services) {
      services[service] = explicitPricing[service] ?? route.provider.pricing.defaults;
    }
  }

  return {
    defaults: defaultRoute.provider.pricing.defaults,
    ...(Object.keys(services).length > 0 ? { services } : {}),
  };
}

function mergeServiceApiProtocols(routes: RouteState[]): Record<string, ServiceApiProtocol[]> | undefined {
  const merged = new Map<string, Set<ServiceApiProtocol>>();

  for (const route of routes) {
    for (const [service, protocols] of Object.entries(route.provider.serviceApiProtocols ?? {})) {
      const current = merged.get(service) ?? new Set<ServiceApiProtocol>();
      for (const protocol of protocols) {
        current.add(protocol);
      }
      merged.set(service, current);
    }
  }

  if (merged.size === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Array.from(merged.entries()).map(([service, protocols]) => [service, Array.from(protocols)]),
  );
}
