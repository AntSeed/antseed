import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  HierarchicalPricingConfig,
  AntseedConfig,
  ProviderPricingConfig,
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
  };
}

function normalizeTokenPricing(value: unknown): TokenPricingUsdPerMillion | null {
  if (!isRecord(value)) return null;
  return {
    inputUsdPerMillion: toFiniteOrNaN(value['inputUsdPerMillion']),
    outputUsdPerMillion: toFiniteOrNaN(value['outputUsdPerMillion']),
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
  };
}

function cloneProviderPricing(
  providers: Record<string, ProviderPricingConfig> | undefined
): Record<string, ProviderPricingConfig> | undefined {
  if (!providers) return undefined;
  const out: Record<string, ProviderPricingConfig> = {};
  for (const [provider, cfg] of Object.entries(providers)) {
    out[provider] = {
      ...(cfg.defaults ? { defaults: clonePricing(cfg.defaults) } : {}),
      ...(cfg.models ? { models: { ...cfg.models } } : {}),
    };
  }
  return out;
}

function mergeModelPricing(
  defaults: Record<string, TokenPricingUsdPerMillion> | undefined,
  value: unknown
): Record<string, TokenPricingUsdPerMillion> | undefined {
  const out: Record<string, TokenPricingUsdPerMillion> = {
    ...(defaults ?? {}),
  };
  if (isRecord(value)) {
    for (const [model, rawPricing] of Object.entries(value)) {
      const parsed = normalizeTokenPricing(rawPricing);
      if (parsed) {
        out[model] = parsed;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeProviderPricing(
  defaults: Record<string, ProviderPricingConfig> | undefined,
  value: unknown
): Record<string, ProviderPricingConfig> | undefined {
  const out = cloneProviderPricing(defaults) ?? {};
  if (isRecord(value)) {
    for (const [provider, rawCfg] of Object.entries(value)) {
      if (!isRecord(rawCfg)) continue;
      const existing = out[provider];
      const parsedDefaults = normalizeTokenPricing(rawCfg['defaults']);
      const next: ProviderPricingConfig = {
        ...(parsedDefaults ? { defaults: parsedDefaults } : (existing?.defaults ? { defaults: existing.defaults } : {})),
      };
      const mergedModels = mergeModelPricing(existing?.models, rawCfg['models']);
      if (mergedModels) {
        next.models = mergedModels;
      }
      if (next.defaults || next.models) {
        out[provider] = next;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeHierarchicalPricing(
  defaults: HierarchicalPricingConfig,
  value: unknown
): HierarchicalPricingConfig {
  if (!isRecord(value)) {
    return {
      defaults: clonePricing(defaults.defaults),
      ...(defaults.providers ? { providers: cloneProviderPricing(defaults.providers) } : {}),
    };
  }
  const mergedProviders = mergeProviderPricing(defaults.providers, value['providers']);
  return {
    defaults: mergeTokenPricing(defaults.defaults, value['defaults']),
    ...(mergedProviders ? { providers: mergedProviders } : {}),
  };
}

function mergeSellerConfig(
  defaults: AntseedConfig['seller'],
  value: unknown
): AntseedConfig['seller'] {
  if (!isRecord(value)) {
    return {
      reserveFloor: defaults.reserveFloor,
      maxConcurrentBuyers: defaults.maxConcurrentBuyers,
      enabledProviders: [...defaults.enabledProviders],
      pricing: mergeHierarchicalPricing(defaults.pricing, undefined),
    };
  }
  return {
    reserveFloor: typeof value['reserveFloor'] === 'number'
      ? value['reserveFloor']
      : defaults.reserveFloor,
    maxConcurrentBuyers: typeof value['maxConcurrentBuyers'] === 'number'
      ? value['maxConcurrentBuyers']
      : defaults.maxConcurrentBuyers,
    enabledProviders: Array.isArray(value['enabledProviders'])
      ? value['enabledProviders'].filter((entry): entry is string => typeof entry === 'string')
      : [...defaults.enabledProviders],
    pricing: mergeHierarchicalPricing(defaults.pricing, value['pricing']),
  };
}

function mergeBuyerConfig(
  defaults: AntseedConfig['buyer'],
  value: unknown
): AntseedConfig['buyer'] {
  if (!isRecord(value)) {
    return {
      preferredProviders: [...defaults.preferredProviders],
      maxPricing: mergeHierarchicalPricing(defaults.maxPricing, undefined),
      minPeerReputation: defaults.minPeerReputation,
      proxyPort: defaults.proxyPort,
    };
  }
  return {
    preferredProviders: Array.isArray(value['preferredProviders'])
      ? value['preferredProviders'].filter((entry): entry is string => typeof entry === 'string')
      : [...defaults.preferredProviders],
    maxPricing: mergeHierarchicalPricing(defaults.maxPricing, value['maxPricing']),
    minPeerReputation: typeof value['minPeerReputation'] === 'number'
      ? value['minPeerReputation']
      : defaults.minPeerReputation,
    proxyPort: typeof value['proxyPort'] === 'number'
      ? value['proxyPort']
      : defaults.proxyPort,
  };
}

function mergeNetworkConfig(
  defaults: AntseedConfig['network'],
  value: unknown
): AntseedConfig['network'] {
  if (!isRecord(value)) {
    return {
      bootstrapNodes: [...defaults.bootstrapNodes],
      ...(defaults.tor ? { tor: { ...defaults.tor, manualPeers: [...(defaults.tor.manualPeers ?? [])] } } : {}),
    };
  }

  const torValue = isRecord(value['tor']) ? value['tor'] : undefined;
  return {
    bootstrapNodes: Array.isArray(value['bootstrapNodes'])
      ? value['bootstrapNodes'].filter((entry): entry is string => typeof entry === 'string')
      : [...defaults.bootstrapNodes],
    ...(defaults.tor || torValue
      ? {
          tor: {
            ...(defaults.tor ? { ...defaults.tor, manualPeers: [...(defaults.tor.manualPeers ?? [])] } : {}),
            ...(torValue ? torValue : {}),
            ...(torValue && Array.isArray(torValue['manualPeers'])
              ? {
                  manualPeers: torValue['manualPeers'].filter(
                    (entry): entry is string => typeof entry === 'string'
                  ),
                }
              : {}),
          },
        }
      : {}),
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
      ...mergeNetworkConfig(defaults.network, parsed['network']),
    },
    providers: Array.isArray(parsed['providers'])
      ? (parsed['providers'] as AntseedConfig['providers'])
      : defaults.providers,
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
