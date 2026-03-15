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
}

/**
 * Provider-level optional defaults and per-service overrides.
 */
export interface ProviderPricingConfig {
  defaults?: TokenPricingUsdPerMillion;
  services?: Record<string, TokenPricingUsdPerMillion>;
}

/**
 * Hierarchical pricing with global defaults and optional provider/service overrides.
 */
export interface HierarchicalPricingConfig {
  defaults: TokenPricingUsdPerMillion;
  providers?: Record<string, ProviderPricingConfig>;
}

/**
 * Optional provider/service category tags for metadata discovery.
 */
export interface SellerServiceCategoryConfig {
  [provider: string]: Record<string, string[]>;
}

/**
 * Seller-specific configuration within the Antseed config.
 */
export interface SellerCLIConfig {
  /** Reserve floor in messages per hour to keep for yourself */
  reserveFloor: number;
  /** Maximum number of concurrent buyer connections */
  maxConcurrentBuyers: number;
  /** Which provider types are enabled for selling */
  enabledProviders: string[];
  /** Seller offer pricing rules in USD per 1M tokens */
  pricing: HierarchicalPricingConfig;
  /** Optional provider/service category tags announced in peer metadata */
  serviceCategories?: SellerServiceCategoryConfig;
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
  /** Optional crypto settlement settings (Base network) */
  crypto?: {
    /** Chain identifier */
    chainId: 'base-local' | 'base-sepolia' | 'base-mainnet';
    /** Base JSON-RPC URL (e.g. http://127.0.0.1:8545 for local anvil) */
    rpcUrl: string;
    /** Deployed AntseedEscrow contract address */
    escrowContractAddress: string;
    /** USDC token contract address */
    usdcContractAddress: string;
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
