import type { ProviderType } from '@antseed/node';

/**
 * Provider configuration for the Antseed config file.
 * This is distinct from the provider.ts ProviderConfig used internally.
 */
export interface CLIProviderConfig {
  /** Provider type identifier */
  type: ProviderType;
  /** API endpoint URL */
  endpoint: string;
  /** Name of the HTTP header used for authentication */
  authHeaderName: string;
  /** Auth token / API key value */
  authValue: string;
  /** Auth type: 'apikey' (default), 'oauth' (with refresh), or 'claude-code' (read from keychain) */
  authType?: 'apikey' | 'oauth' | 'claude-code';
  /** OAuth refresh token (required when authType is 'oauth') */
  refreshToken?: string;
  /** Token expiration timestamp in epoch ms (used with authType 'oauth') */
  expiresAt?: number;
}

/**
 * Re-export ProviderType for convenience in config commands.
 */
export type { ProviderType } from '@antseed/node';

/**
 * Dual token pricing in USD per 1M tokens.
 */
export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}

/**
 * Hierarchical pricing used for BUYER max-willing-to-pay rules only.
 * Seller pricing has moved to `seller.providers[name].services[id]`.
 */
export interface HierarchicalPricingConfig {
  defaults: TokenPricingUsdPerMillion;
}

/**
 * One service offered by a seller under a given provider.
 */
export interface SellerServiceConfig {
  /**
   * Upstream model identifier the provider plugin will forward requests to.
   * When omitted, the service ID itself is used verbatim. Example: service
   * `"deepseek-v3.1"` with upstreamModel `"deepseek-ai/DeepSeek-V3.1"`.
   */
  upstreamModel?: string;
  /** Normie-friendly tags announced in peer metadata (e.g. "chat", "coding"). */
  categories?: string[];
  /**
   * Pricing override for this specific service. If absent, the provider's
   * defaults are used.
   */
  pricing?: TokenPricingUsdPerMillion;
}

/**
 * Per-provider seller configuration.
 */
export interface SellerProviderConfig {
  /** Optional upstream API base URL override (e.g. "https://api.together.ai"). */
  baseUrl?: string;
  /** Fallback pricing used by services that don't set their own `pricing`. */
  defaults?: TokenPricingUsdPerMillion;
  /** Services offered under this provider, keyed by announced service ID. */
  services: Record<string, SellerServiceConfig>;
}

/**
 * Seller-specific configuration within the Antseed config.
 */
export interface SellerCLIConfig {
  /** Reserve floor in messages per hour to keep for yourself */
  reserveFloor: number;
  /** Maximum number of concurrent buyer connections */
  maxConcurrentBuyers: number;
  /** Which provider plugins are enabled for selling */
  enabledProviders: string[];
  /**
   * Per-provider configuration: upstream base URL, defaults, and the services
   * offered under each provider. The set of keys here also determines which
   * services this peer announces.
   */
  providers: Record<string, SellerProviderConfig>;
  /**
   * Ant agent configuration. Can be:
   * - A string path to a single agent directory (applies to all services)
   * - A record mapping service IDs to agent directory paths (per-service agents).
   *   Use `"*"` key as a fallback for unmatched services.
   *
   * Each directory must contain an `agent.json` manifest.
   * Relative paths are resolved from the config file's directory.
   */
  agentDir?: string | Record<string, string>;
  /** Publicly reachable seller address override announced in metadata, e.g. "peer.example.com:6882". */
  publicAddress?: string;
}

/**
 * Buyer-specific configuration within the Antseed config.
 */
export interface BuyerCLIConfig {
  /** Buyer max willing-to-pay rules in USD per 1M tokens */
  maxPricing: HierarchicalPricingConfig;
  /** Minimum peer reputation score (0-100) */
  minPeerReputation: number;
  /** Local proxy listen port */
  proxyPort: number;
}

/**
 * Payment configuration within the Antseed config.
 */
export interface PaymentsCLIConfig {
  /** Preferred payment method */
  preferredMethod: 'crypto';
  /** Platform fee rate (0-1) */
  platformFeeRate: number;
  /** Minimum USDC per request in base units (seller). Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Maximum USDC the buyer authorizes per single request in base units. Default: "100000" ($0.10). */
  maxPerRequestUsdc?: string;
  /** Maximum total USDC the buyer will reserve in a single SpendingAuth in base units. Default: "1000000" ($1.00). */
  maxReserveAmountUsdc?: string;
  /** Optional crypto settlement settings (Base network) */
  crypto?: {
    /** Chain identifier */
    chainId: 'base-local' | 'base-sepolia' | 'base-mainnet';
    /** Base JSON-RPC URL (e.g. http://127.0.0.1:8545 for local anvil) */
    rpcUrl: string;
    /** Deployed AntseedDeposits contract address */
    depositsContractAddress: string;
    /** Deployed AntseedChannels contract address */
    channelsContractAddress: string;
    /** Deployed AntseedStaking contract address */
    stakingContractAddress?: string;
    /** USDC token contract address */
    usdcContractAddress: string;
    /** Deployed AntseedIdentity (ERC-8004 registry) contract address */
    identityRegistryAddress?: string;
    /** Deployed AntseedEmissions contract address */
    emissionsContractAddress?: string;
    /** Deployed AntseedSubPool contract address */
    subPoolContractAddress?: string;
    /** Default lock amount per session in human-readable USDC (e.g. "1" = 1 USDC) */
    defaultLockAmountUSDC?: string;
  };
}

/**
 * Network configuration within the Antseed config.
 */
export interface NetworkCLIConfig {
  /** Additional bootstrap nodes for DHT discovery (host:port pairs) */
  bootstrapNodes: string[];
}

/**
 * Top-level Antseed configuration structure.
 */
export interface AntseedConfig {
  /** Node identity information (peer ID, display name) */
  identity: {
    displayName: string;
    walletAddress?: string;
  };
  /** Configured LLM provider credentials */
  providers: CLIProviderConfig[];
  /** Seller mode settings */
  seller: SellerCLIConfig;
  /** Buyer mode settings */
  buyer: BuyerCLIConfig;
  /** Payment settings */
  payments: PaymentsCLIConfig;
  /** Network / DHT settings */
  network: NetworkCLIConfig;
  /** Installed plugins */
  plugins?: { name: string; package: string; installedAt: string }[];
}

/**
 * ProviderConfig alias for use in config commands.
 * Maps to CLIProviderConfig.
 */
export type ProviderConfig = CLIProviderConfig;
