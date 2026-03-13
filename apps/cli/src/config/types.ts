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
 * Injection position for a middleware entry.
 */
export type MiddlewarePosition = 'system-prepend' | 'system-append' | 'prepend' | 'append';

/**
 * A single middleware entry referencing a Markdown file on disk.
 */
export interface SellerMiddlewareConfig {
  /** Path to the .md file (relative to the config file's directory, or absolute). */
  file: string;
  /** Where to inject the content in the LLM request. */
  position: MiddlewarePosition;
  /** Role for 'prepend'/'append' positions. Defaults to 'user'. */
  role?: string;
  /** If set, only inject for requests targeting one of these service IDs. Applies to all services when omitted. */
  services?: string[];
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
  /** Optional middleware files to inject into every LLM request. */
  middleware?: SellerMiddlewareConfig[];
  /**
   * Custom confidentiality prompt appended to the system prompt whenever middleware
   * is active, instructing the LLM not to reveal injected content.
   * Omit or set to an empty string to use the built-in default prompt.
   * There is no opt-out: a confidentiality prompt is always injected when middleware fires.
   */
  middlewareConfidentialityPrompt?: string;
  /**
   * Path to a directory containing skill subdirectories for on-demand loading.
   * Each subdirectory must contain a `SKILL.md` file with YAML frontmatter (name, description).
   * Skills are loaded dynamically by the LLM via the `antseed_load` tool when needed,
   * rather than being injected into every request like middleware.
   * Relative paths are resolved from the config file's directory.
   */
  skillsDir?: string;
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
