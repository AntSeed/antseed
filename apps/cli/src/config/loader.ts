import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  HierarchicalPricingConfig,
  AntseedConfig,
  SellerProviderConfig,
  SellerServiceConfig,
  TokenPricingUsdPerMillion,
} from './types.js';
import { createDefaultConfig } from './defaults.js';
import { assertValidConfig } from './validation.js';

/**
 * Resolve a config path, expanding ~ to the user's home directory.
 */
function resolveConfigPath(configPath: string): string {
  if (configPath.startsWith('~')) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteOrNaN(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function clonePricing(pricing: TokenPricingUsdPerMillion): TokenPricingUsdPerMillion {
  return {
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    ...(pricing.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
  };
}

function normalizeTokenPricing(value: unknown): TokenPricingUsdPerMillion | null {
  if (!isRecord(value)) return null;
  return {
    inputUsdPerMillion: toFiniteOrNaN(value['inputUsdPerMillion']),
    outputUsdPerMillion: toFiniteOrNaN(value['outputUsdPerMillion']),
    ...(value['cachedInputUsdPerMillion'] != null ? { cachedInputUsdPerMillion: toFiniteOrNaN(value['cachedInputUsdPerMillion']) } : {}),
  };
}

function mergeTokenPricing(
  defaults: TokenPricingUsdPerMillion,
  value: unknown
): TokenPricingUsdPerMillion {
  if (!isRecord(value)) {
    return clonePricing(defaults);
  }
  return {
    inputUsdPerMillion: typeof value['inputUsdPerMillion'] === 'number'
      ? value['inputUsdPerMillion']
      : defaults.inputUsdPerMillion,
    outputUsdPerMillion: typeof value['outputUsdPerMillion'] === 'number'
      ? value['outputUsdPerMillion']
      : defaults.outputUsdPerMillion,
    ...(typeof value['cachedInputUsdPerMillion'] === 'number'
      ? { cachedInputUsdPerMillion: value['cachedInputUsdPerMillion'] }
      : defaults.cachedInputUsdPerMillion != null
        ? { cachedInputUsdPerMillion: defaults.cachedInputUsdPerMillion }
        : {}),
  };
}

function mergeHierarchicalPricing(
  defaults: HierarchicalPricingConfig,
  value: unknown
): HierarchicalPricingConfig {
  if (!isRecord(value)) {
    return { defaults: clonePricing(defaults.defaults) };
  }
  return { defaults: mergeTokenPricing(defaults.defaults, value['defaults']) };
}

/* ── Seller provider + services merge ──────────────────────────────────── */

function normalizeCategories(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function normalizeSellerService(value: unknown): SellerServiceConfig | null {
  if (!isRecord(value)) return null;
  const out: SellerServiceConfig = {};
  if (typeof value['upstreamModel'] === 'string' && value['upstreamModel'].trim().length > 0) {
    out.upstreamModel = value['upstreamModel'].trim();
  }
  const categories = normalizeCategories(value['categories']);
  if (categories) {
    out.categories = categories;
  }
  const pricing = normalizeTokenPricing(value['pricing']);
  if (pricing) {
    out.pricing = pricing;
  }
  return out;
}

function normalizeSellerProvider(value: unknown): SellerProviderConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value['plugin'] !== 'string' || value['plugin'].trim().length === 0) return null;
  const out: SellerProviderConfig = { plugin: value['plugin'].trim(), services: {} };
  if (typeof value['baseUrl'] === 'string' && value['baseUrl'].trim().length > 0) {
    out.baseUrl = value['baseUrl'].trim();
  }
  const defaults = normalizeTokenPricing(value['defaults']);
  if (defaults) {
    out.defaults = defaults;
  }
  const rawServices = value['services'];
  if (isRecord(rawServices)) {
    for (const [serviceId, rawService] of Object.entries(rawServices)) {
      const parsed = normalizeSellerService(rawService);
      if (parsed) {
        out.services[serviceId] = parsed;
      }
    }
  }
  return out;
}

function mergeSellerProviders(
  defaults: Record<string, SellerProviderConfig>,
  value: unknown,
): Record<string, SellerProviderConfig> {
  const out: Record<string, SellerProviderConfig> = {};
  for (const [name, cfg] of Object.entries(defaults)) {
    out[name] = {
      plugin: cfg.plugin,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.defaults ? { defaults: clonePricing(cfg.defaults) } : {}),
      services: { ...cfg.services },
    };
  }
  if (!isRecord(value)) return out;
  for (const [name, rawProvider] of Object.entries(value)) {
    const parsed = normalizeSellerProvider(rawProvider);
    if (parsed) {
      out[name] = parsed;
    }
  }
  return out;
}

function normalizeAgentDir(
  value: unknown,
  fallback?: string | Record<string, string>,
): { agentDir: string | Record<string, string> } | Record<string, never> {
  if (typeof value === 'string') return { agentDir: value };
  if (isRecord(value)) {
    // Per-service map: { "service-id": "./path", ... }
    const map: Record<string, string> = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string') map[key] = val;
    }
    if (Object.keys(map).length > 0) return { agentDir: map };
  }
  return fallback ? { agentDir: fallback } : {};
}

function mergeSellerConfig(
  defaults: AntseedConfig['seller'],
  value: unknown
): AntseedConfig['seller'] {
  if (!isRecord(value)) {
    return {
      reserveFloor: defaults.reserveFloor,
      maxConcurrentBuyers: defaults.maxConcurrentBuyers,
      providers: mergeSellerProviders(defaults.providers, undefined),
      publicAddress: defaults.publicAddress,
      ...(defaults.agentDir ? { agentDir: defaults.agentDir } : {}),
    };
  }

  return {
    reserveFloor: typeof value['reserveFloor'] === 'number'
      ? value['reserveFloor']
      : defaults.reserveFloor,
    maxConcurrentBuyers: typeof value['maxConcurrentBuyers'] === 'number'
      ? value['maxConcurrentBuyers']
      : defaults.maxConcurrentBuyers,
    providers: mergeSellerProviders(defaults.providers, value['providers']),
    publicAddress: typeof value['publicAddress'] === 'string'
      ? value['publicAddress']
      : defaults.publicAddress,
    ...(normalizeAgentDir(value['agentDir'], defaults.agentDir)),
  };
}

function mergeBuyerConfig(
  defaults: AntseedConfig['buyer'],
  value: unknown
): AntseedConfig['buyer'] {
  if (!isRecord(value)) {
    return {
      maxPricing: mergeHierarchicalPricing(defaults.maxPricing, undefined),
      minPeerReputation: defaults.minPeerReputation,
      proxyPort: defaults.proxyPort,
    };
  }
  return {
    maxPricing: mergeHierarchicalPricing(defaults.maxPricing, value['maxPricing']),
    minPeerReputation: typeof value['minPeerReputation'] === 'number'
      ? value['minPeerReputation']
      : defaults.minPeerReputation,
    proxyPort: typeof value['proxyPort'] === 'number'
      ? value['proxyPort']
      : defaults.proxyPort,
  };
}

/**
 * Load configuration from a JSON file.
 * Returns default configuration if the file does not exist.
 */
export async function loadConfig(configPath: string): Promise<AntseedConfig> {
  const resolved = resolveConfigPath(configPath);

  let raw: string;
  try {
    raw = await readFile(resolved, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return createDefaultConfig();
    }
    throw err;
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    console.warn(`Warning: Could not parse config at ${resolved}. Using defaults.`);
    return createDefaultConfig();
  }

  const defaults = createDefaultConfig();
  const parsed = isRecord(parsedRaw) ? parsedRaw : {};

  const merged: AntseedConfig = {
    ...defaults,
    ...(parsed as Partial<AntseedConfig>),
    identity: {
      ...defaults.identity,
      ...(isRecord(parsed['identity']) ? parsed['identity'] : {}),
    },
    seller: mergeSellerConfig(defaults.seller, parsed['seller']),
    buyer: mergeBuyerConfig(defaults.buyer, parsed['buyer']),
    payments: {
      ...defaults.payments,
      ...(isRecord(parsed['payments']) ? parsed['payments'] : {}),
    },
    network: {
      ...defaults.network,
      ...(isRecord(parsed['network']) ? parsed['network'] : {}),
    },
  };

  assertValidConfig(merged);
  return merged;
}

/**
 * Save configuration to a JSON file.
 * Creates the directory if it doesn't exist.
 */
export async function saveConfig(configPath: string, config: AntseedConfig): Promise<void> {
  const resolved = resolveConfigPath(configPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(config, null, 2), 'utf-8');
}
