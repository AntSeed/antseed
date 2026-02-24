import type { ProviderType } from './metering.js';

export interface SellerProviderPricingConfig {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/**
 * Per-provider capacity and pricing configuration for sellers.
 */
export interface SellerProviderConfig {
  /** Provider identifier (must match a key in AntseedConfig.providers) */
  type: ProviderType;
  /** Whether this provider is enabled for selling */
  enabled: boolean;
  /** Plan limit in messages per hour. */
  planLimitMsgPerHour: number;
  /** Reserve floor in messages per hour. */
  reserveFloorMsgPerHour: number;
  /** Default pricing in USD per 1M tokens. */
  pricing: SellerProviderPricingConfig;
}

/**
 * Top-level seller configuration.
 */
export interface SellerConfig {
  /** Whether seller mode is enabled */
  enabled: boolean;
  /** Maximum number of concurrent buyer connections */
  maxConcurrentBuyers: number;
  /** Per-provider selling configuration */
  providers: SellerProviderConfig[];
  /** Session timeout in ms. Default: 300_000 (5 minutes). */
  sessionTimeoutMs: number;
  /** DHT re-announce interval in ms. Default: 60_000 (1 minute). */
  announceIntervalMs: number;
}
