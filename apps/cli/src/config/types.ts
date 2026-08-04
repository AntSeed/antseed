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
  /** Plugin name or npm package that powers this provider (e.g. "openai", "@antseed/provider-openai"). */
  plugin: string;
  /** Optional upstream API base URL override (e.g. "https://api.together.ai"). */
  baseUrl?: string;
  /**
   * Name of the environment variable holding this provider's API key.
   * Allows multiple providers on the same peer to use different credentials.
   * Example: `"ZAI_API_KEY"` reads `process.env.ZAI_API_KEY` and injects it
   * as `OPENAI_API_KEY` into the plugin config. When omitted, the plugin's
   * default env var (`OPENAI_API_KEY`) is used.
   */
  apiKeyEnv?: string;
  /**
   * Rewrite request paths before forwarding upstream. Keys are exact incoming
   * paths, values are their replacements.
   * Example: `{ "/v1/chat/completions": "/v4/chat/completions" }`
   */
  pathRewrite?: Record<string, string>;
  /** Fallback pricing used by services that don't set their own `pricing`. */
  defaults?: TokenPricingUsdPerMillion;
  /** Services offered under this provider, keyed by announced service ID. */
  services: Record<string, SellerServiceConfig>;
}

export type DomainVerificationMethod = 'dns-txt' | 'https-well-known';

export interface DomainVerificationConfig {
  /** Domain name to prove, without scheme, path, or port. */
  domain: string;
  /** Accepted proof transports. Omit to let clients try every supported method. */
  methods?: DomainVerificationMethod[];
}

export interface GithubVerificationConfig {
  /** GitHub username to prove. */
  username: string;
  /**
   * Public repository holding `antseed.json` at its root. Defaults to the
   * profile repository `<username>/<username>` when omitted.
   */
  repository?: string;
}

export interface VerificationConfig {
  /** Domain ownership claims. */
  domains?: DomainVerificationConfig[];
  /** GitHub account ownership claims. */
  github?: GithubVerificationConfig[];
}

/**
 * Seller-specific configuration within the Antseed config.
 */
export interface SellerCLIConfig {
  /** Reserve floor in messages per hour to keep for yourself */
  reserveFloor: number;
  /** Maximum number of concurrent buyer connections */
  maxConcurrentBuyers: number;
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
  /** Optional external ownership claims announced in signed peer metadata. */
  verifications?: VerificationConfig;
  /** Maximum upload body size (bytes) accepted from buyers per request. Default: 64 MiB. */
  maxUploadBodyBytes?: number;
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
  /** How often the buyer refreshes its peer list from the DHT in the background (ms) */
  peerRefreshIntervalMs: number;
  /** Timeout in ms for each HTTP metadata fetch during peer discovery */
  metadataFetchTimeoutMs: number;
  /** Disable per-service attribution in buyer-signed metadata v2. */
  disableMetadataV2Services: boolean;
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
  /**
   * Minimum unsettled delta (base units) required before the seller's idle
   * settle loop submits a tx. Skips dust settles whose gas cost exceeds the
   * amount. Only applied in idle settle — close() still settles the full
   * amount. Default: "2000" (~$0.002).
   */
  minSettleDelta?: string;
  /** Optional seller-side slack for estimate-only reserve preflight checks. Unset disables estimate-only rejection. */
  reserveEstimateOverdraftUsdc?: string;
  /**
   * Maximum USDC the buyer authorizes per single request in base units — the
   * per-request overdraft window beyond the buyer's independently-verified
   * cumulative cost. Caps how much a misreporting or malicious seller can
   * extract in one catch-up round trip. Default: "300000" ($0.30), sized to
   * fit a single long-context request on the priciest published models.
   */
  maxPerRequestUsdc?: string;
  /** Maximum total USDC the buyer will reserve in a single SpendingAuth in base units. Default: "1000000" ($1.00). */
  maxReserveAmountUsdc?: string;
  /**
   * Optional on-chain seller contract (e.g. DiemStakingProxy). When set, the
   * peer publishes it in metadata; buyers verify the binding via
   * `sellerContract.isOperator(peerAddress)` on-chain. The peer identity wallet
   * must be an authorized operator on the contract.
   */
  sellerContract?: {
    /** 0x-prefixed contract address. */
    address: string;
  };
  /** Optional crypto settlement settings (Base network) */
  crypto?: {
    /** Chain identifier */
    chainId: 'base-local' | 'base-sepolia' | 'base-mainnet';
    /** Base JSON-RPC URL override (e.g. http://127.0.0.1:8545 for local anvil) */
    rpcUrl?: string;
    /** Additional RPC endpoints tried in order via ethers FallbackProvider. */
    fallbackRpcUrls?: string[];
    /** Deployed AntseedDeposits contract address override */
    depositsContractAddress?: string;
    /** Deployed AntseedChannels contract address override */
    channelsContractAddress?: string;
    /** Deployed AntseedFreeUsage contract address override */
    freeUsageContractAddress?: string;
    /** Deployed AntseedStaking contract address */
    stakingContractAddress?: string;
    /** USDC token contract address override */
    usdcContractAddress?: string;
    /** Deployed AntseedIdentity (ERC-8004 registry) contract address */
    identityRegistryAddress?: string;
    /** Deployed AntseedEmissions contract address */
    emissionsContractAddress?: string;
    /** Deployed AntseedVerifierRegistry contract address */
    verifierRegistryAddress?: string;
    /** Deployed AntseedVerifierRewards contract address */
    verifierRewardsAddress?: string;
    /** Deployed AntseedVerifierPointsPolicy contract address */
    verifierPointsPolicyAddress?: string;
    /** Default lock amount per session in human-readable USDC (e.g. "1" = 1 USDC) */
    defaultLockAmountUSDC?: string;
  };
}

/** Verifier configuration for model-wide paid verification runs. */
export interface VerifierCLIConfig {
  /** Directory containing one reusable 100-probe reference per model. */
  referencesDir?: string;
  /** Directory for per-peer evidence packs and run summaries. */
  evidenceDir?: string;
  /** Timeout for each paid probe request. Default: 120000. */
  probeRequestTimeoutMs?: number;
  /** Hard total spend cap for one run, in human-readable USDC. */
  maxTotalSpendUSDC?: string;
  /** Trusted endpoint used only when a model's fixed reference is missing. */
  referenceEndpoint?: VerifierReferenceEndpointConfig;
}

export interface VerifierReferenceModelConfig {
  /** Model id sent to the reference endpoint. */
  upstreamModel: string;
  /** Models used to reject non-distinguishing candidate probes. */
  contrastModels: string[];
}

export interface VerifierReferenceEndpointConfig {
  /** OpenAI-compatible base URL, e.g. "http://127.0.0.1:8377/v1". */
  baseUrl: string;
  /** API key sent as a Bearer token. Prefer apiKeyEnv over inlining secrets. */
  apiKey?: string;
  /** Environment variable containing the API key. */
  apiKeyEnv?: string;
  /** Stable operator-controlled identity used to invalidate references. */
  sourceId: string;
  /** Whether references from this endpoint are smoke-only or trusted. */
  trust: 'smoke' | 'trusted';
  /** Optional AntSeed buyer-proxy peer pin. Omit for direct trusted APIs. */
  antseedPeerId?: string;
  /** Network service id to upstream reference/contrast model configuration. */
  models: Record<string, VerifierReferenceModelConfig>;
}

export interface VerifierReferencePolicyConfig {
  /** @deprecated Catalog warm-up compatibility option. */
  certifiedProbeCount?: number;
  /** @deprecated Alias for minimumAuditProbeCount. */
  auditProbeCount?: number;
  /** @deprecated Probes are never reused for the same agent/service. */
  maxProbeUsesPerTarget?: number;
  /** Initial probes selected for each audit. Default: 100. */
  minimumAuditProbeCount?: number;
  /** Maximum probes selected for an adaptive audit. Default: 750. */
  maximumAuditProbeCount?: number;
  /** Adaptive growth increment. Default: 10. */
  auditProbeStep?: number;
  /** Required one-sided binomial statistical power. Default: 0.9. */
  minimumStatisticalPower?: number;
  /** Smallest excess target mismatch rate the audit is powered to detect. Default: 0.1. */
  minimumMismatchDelta?: number;
  /** Family-wide false-positive rate divided across the discovered cohort. Default: 0.05. */
  familyWideAlpha?: number;
  /** Confidence used for the reference Clopper-Pearson upper bound. Default: 0.99. */
  referenceConfidence?: number;
  /** Required parsed and authenticated target coverage for benchmark verdicts. Default: 1. */
  minimumAuthenticatedCoverage?: number;
  /** Maximum reference age in days. Default: 49. */
  maxReferenceAgeDays?: number;
  /** @deprecated Alias for maxRequestsPerRound. */
  maxRequestsPerBuild?: number;
  /** Maximum upstream calls while preparing one service round. Default: 2000. */
  maxRequestsPerRound?: number;
  /** Timeout for one reference request. Default: 120000. */
  requestTimeoutMs?: number;
  /** Retry count after the initial batch attempt. Default: 3. */
  batchRetryCount?: number;
  /** Adaptive generation domains processed concurrently. Default: 3. */
  generationDomainConcurrency?: number;
  /** Maximum concurrent upstream reference requests. Default: 4. */
  maxConcurrentReferenceRequests?: number;
  /** Maximum concurrent upstream requests for one model. Default: 2. */
  maxConcurrentRequestsPerModel?: number;
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
  /** Seller mode settings */
  seller: SellerCLIConfig;
  /** Buyer mode settings */
  buyer: BuyerCLIConfig;
  /** Payment settings */
  payments: PaymentsCLIConfig;
  /** Verifier mode settings (model-verification network) */
  verifier?: VerifierCLIConfig;
  /** Network / DHT settings */
  network: NetworkCLIConfig;
  /** Installed plugins */
  plugins?: { name: string; package: string; installedAt: string }[];
}
