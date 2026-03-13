import type { BuyerCLIConfig, AntseedConfig, SellerCLIConfig } from './types.js';

export interface SellerRuntimeOverrides {
  reserveFloor?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export interface BuyerRuntimeOverrides {
  proxyPort?: number;
  minPeerReputation?: number;
  preferredProviders?: string[];
  maxInputUsdPerMillion?: number;
  maxOutputUsdPerMillion?: number;
}

export interface ResolveEffectiveConfigInput {
  config: AntseedConfig;
  env?: NodeJS.ProcessEnv;
  sellerOverrides?: SellerRuntimeOverrides;
  buyerOverrides?: BuyerRuntimeOverrides;
}

function parseEnvNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveEffectiveSellerConfig(input: ResolveEffectiveConfigInput): SellerCLIConfig {
  const env = input.env ?? process.env;
  const seller = structuredClone(input.config.seller);

  const envInputUsdPerMillion = parseEnvNumber(env, 'ANTSEED_SELLER_INPUT_USD_PER_MILLION');
  const envOutputUsdPerMillion = parseEnvNumber(env, 'ANTSEED_SELLER_OUTPUT_USD_PER_MILLION');

  if (envInputUsdPerMillion !== undefined) {
    seller.pricing.defaults.inputUsdPerMillion = envInputUsdPerMillion;
  }
  if (envOutputUsdPerMillion !== undefined) {
    seller.pricing.defaults.outputUsdPerMillion = envOutputUsdPerMillion;
  }

  const overrides = input.sellerOverrides;
  if (overrides?.reserveFloor !== undefined) {
    seller.reserveFloor = overrides.reserveFloor;
  }
  if (overrides?.inputUsdPerMillion !== undefined) {
    seller.pricing.defaults.inputUsdPerMillion = overrides.inputUsdPerMillion;
  }
  if (overrides?.outputUsdPerMillion !== undefined) {
    seller.pricing.defaults.outputUsdPerMillion = overrides.outputUsdPerMillion;
  }

  return seller;
}

export function resolveEffectiveBuyerConfig(input: ResolveEffectiveConfigInput): BuyerCLIConfig {
  const env = input.env ?? process.env;
  const buyer = structuredClone(input.config.buyer);

  const envMinReputation = parseEnvNumber(env, 'ANTSEED_BUYER_MIN_REPUTATION');
  const envMaxInputUsdPerMillion = parseEnvNumber(env, 'ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION');
  const envMaxOutputUsdPerMillion = parseEnvNumber(env, 'ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION');

  if (envMinReputation !== undefined) {
    buyer.minPeerReputation = envMinReputation;
  }
  if (envMaxInputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.inputUsdPerMillion = envMaxInputUsdPerMillion;
  }
  if (envMaxOutputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.outputUsdPerMillion = envMaxOutputUsdPerMillion;
  }

  const overrides = input.buyerOverrides;
  if (overrides?.proxyPort !== undefined) {
    buyer.proxyPort = overrides.proxyPort;
  }
  if (overrides?.minPeerReputation !== undefined) {
    buyer.minPeerReputation = overrides.minPeerReputation;
  }
  if (overrides?.preferredProviders && overrides.preferredProviders.length > 0) {
    buyer.preferredProviders = [...overrides.preferredProviders];
  }
  if (overrides?.maxInputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.inputUsdPerMillion = overrides.maxInputUsdPerMillion;
  }
  if (overrides?.maxOutputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.outputUsdPerMillion = overrides.maxOutputUsdPerMillion;
  }

  return buyer;
}

export function resolveEffectiveRoleConfig(input: ResolveEffectiveConfigInput): {
  seller: SellerCLIConfig;
  buyer: BuyerCLIConfig;
} {
  return {
    seller: resolveEffectiveSellerConfig(input),
    buyer: resolveEffectiveBuyerConfig(input),
  };
}
