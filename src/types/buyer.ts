import type { ProviderType } from './metering.js';

/**
 * Per-provider preferences for the buyer.
 */
export interface BuyerProviderPreference {
  /** Provider type to route through P2P */
  type: ProviderType;
  /** Whether this provider is enabled for P2P routing */
  enabled: boolean;
  /** Maximum price per 1K tokens in USD cents the buyer is willing to pay. */
  maxPricePerKToken: number;
}

/**
 * Top-level buyer configuration.
 */
export interface BuyerConfig {
  /** Whether buyer mode is enabled */
  enabled: boolean;
  /** Local proxy listen port. Default: 8377 */
  proxyPort: number;
  /** Local proxy listen host. Default: '127.0.0.1' */
  proxyHost: string;
  /** Per-provider preferences */
  providers: BuyerProviderPreference[];
  /** Minimum peer reputation score (0-100). Default: 50 */
  minPeerReputation: number;
  /** Maximum number of peers to maintain in the pool. Default: 10 */
  maxPoolSize: number;
  /** Health check interval in ms. Default: 30_000 */
  healthCheckIntervalMs: number;
  /** Timeout for requests forwarded to peers in ms. Default: 120_000 */
  requestTimeoutMs: number;
  /** Whether to automatically set env vars for CLI tools. Default: true */
  autoSetEnvVars: boolean;
}
