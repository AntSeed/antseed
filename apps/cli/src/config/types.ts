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

export interface BuyerVerificationConfig {
  /** Random sample rate for storing full response-auth evidence, from 0 to 1. */
  sampleRate?: number;
  /** Maximum combined encoded request + response bytes per sample. */
  maxSampleBytes?: number;
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
  /** Buyer-side response-auth evidence sampling settings. */
  verification?: BuyerVerificationConfig;
  /** Opt-in probe-carrier mode: serve probe jobs for whitelisted verifiers. */
  delegate?: DelegateCLIConfig;
}

/**
 * Opt-in delegate (probe carrier) settings. A participating buyer connects
 * to on-chain-approved verifiers discovered on the DHT and relays their
 * probe requests over its ordinary paid buyer path. Carried jobs earn
 * delegate credits that accrue ON-CHAIN when the verifier anchors the
 * seller-signed exchanges naming this buyer; the worker discovers them from
 * DelegateCreditsAccrued logs and the buyer's deposits operator claims them
 * on-chain for a share of the verification emissions bucket. There is no
 * payout setting — the contract resolves the operator at claim time.
 */
export interface DelegateCLIConfig {
  enabled: boolean;
  /** Max probe jobs run concurrently. Default: 2. */
  maxConcurrentJobs?: number;
  /** Rate cap on carried jobs. Default: 60. */
  maxJobsPerHour?: number;
  /** How often to scan the DHT for verifiers to serve. Default: 300000 (5 min). */
  discoveryIntervalMs?: number;
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
    /** Default lock amount per session in human-readable USDC (e.g. "1" = 1 USDC) */
    defaultLockAmountUSDC?: string;
  };
}

/**
 * Verifier-specific configuration within the Antseed config.
 * Used by `antseed verifier start` — a whitelisted verifier probes sellers
 * advertising the configured services and attests model-identity verdicts
 * on-chain.
 */
export interface VerifierCLIConfig {
  /**
   * Advertised services (model IDs) to verify, e.g. ["kimi-k2", "deepseek-v3.1"].
   * Empty (or omitted): auto-discover mode — the verifier audits every service
   * advertised by peers on the network.
   */
  services?: string[];
  /** Max credited audits this verifier attempts per emissions epoch. Default: 50. */
  maxAuditsPerEpoch?: number;
  /** Numeric probes per audited seller. Default: 24. */
  probesPerAudit?: number;
  /**
   * Max probes woven into a single stealth chat request. Lower = more organic
   * (harder for a seller to detect probing) but more requests per audit, each
   * incurring the per-request minimum fee. Default: 3.
   */
  maxProbesPerRequest?: number;
  /** Minimum sellers advertising the same service required for a cohort audit. Default: 3. */
  cohortMinSize?: number;
  /** Maximum sellers probed per cohort round. Default: 10. */
  cohortMaxSize?: number;
  /** Pause between audit rounds in ms. Default: 300000 (5 min). */
  auditIntervalMs?: number;
  /** Skip sellers audited on-chain within this many seconds. Default: on-chain auditCooldown. */
  stalenessWindowSecs?: number;
  /**
   * Origin of probes when no reference matches the service. `llm` authors
   * fresh candidates per audit via the configured `upstream` and certifies
   * them with the existing reference machinery (cheap, unbounded supply, no
   * fixed generator fingerprint — falls back to `compositional` when
   * authoring fails); `compositional` draws from a large procedural
   * entity/attribute space so a seller cannot memorize a finite bank; `bank`
   * uses the small built-in fixture (tests/bootstrap). A matching reference
   * always takes precedence (reference mode). Default: "llm" when `upstream`
   * is configured, otherwise "compositional".
   */
  probeSource?: 'llm' | 'compositional' | 'bank';
  /**
   * Upstream model id used to AUTHOR probe candidates in `llm` probe-source
   * mode (certification always runs against the audited service's reference
   * model). Defaults to the certification model, i.e. the upstream model
   * resolved for the audited service.
   */
  probeAuthorModel?: string;
  /**
   * Recently-used probe ids remembered per service and excluded from later
   * rounds, so a revealed probe is not reused until the pool cycles. 0 disables
   * rotation. Ignored in reference mode. Default: 2000.
   */
  probeRotationHistory?: number;
  /**
   * Directory of trusted KBF reference files (JSON, spec 07 reference schema).
   * When a reference matches an audited service, reference-based KBF verdicts
   * are computed in addition to cohort consensus. Default: <dataDir>/fingerprints/references.
   */
  referencesDir?: string;
  /**
   * Directory where audit packs are published, one per audit round
   * (`<publishDir>/<probeCommitment>.json`, canonical JSON bytes whose
   * SHA-256 is the on-chain evidenceHash). The pack holds the revealed probe
   * set plus every request/response plaintext and seller ResponseAuth, so
   * anyone can re-run the audit from public data (`antseed audit verify`).
   * Default: <dataDir>/verifier/packs.
   */
  publishDir?: string;
  /**
   * Public base URL under which packs written to `publishDir` are served
   * (e.g. "https://packs.example.com/audits"). When set, each round posts the
   * pack URI `<publishBaseUrl>/<probeCommitment>.json` on-chain in the reveal,
   * so a re-runner (`antseed audit verify`) can fetch the pack from chain data
   * alone. Unset publishes packs locally only (verifiers must pass --pack).
   */
  publishBaseUrl?: string;
  /**
   * Milliseconds to wait between the round's attestations and revealing the
   * probe set on-chain. 0 (default) reveals immediately after attesting;
   * end-of-epoch reveal batching is a future knob.
   */
  revealDelayMs?: number;
  /** Directory for the per-service probe rotation log. Default: <dataDir>/fingerprints/probe-log. */
  probeLogDir?: string;
  /**
   * Trusted OpenAI-compatible upstream used to enroll certified KBF references
   * (`antseed verifier reference build`, plus automatic enrollment in the
   * daemon for discovered services that lack one). Point it at the canonical
   * provider, OpenRouter, or a local deployment of the open weights. With a
   * reference, a service can be audited down to a single seller; without one,
   * cohort consensus needs cohortMinSize sellers.
   */
  upstream?: VerifierUpstreamConfig;
  /**
   * Delegated probing: announce as a delegation host on the DHT and route
   * probes through opt-in organic buyers instead of this daemon's own
   * (whitelist-linkable) buyer identity. Carried exchanges credit each carrier
   * on-chain at anchor time; carriers claim those credits themselves via their
   * operator (no voucher is signed or sent).
   */
  delegation?: VerifierDelegationConfig;
}

export interface VerifierDelegationConfig {
  enabled: boolean;
  /** TCP port for the delegate signaling listener. Default: 6882. */
  signalingPort?: number;
  /** Per-job execution budget granted to a delegate. Default: 60000. */
  jobTimeoutMs?: number;
  /** Delegates required before probing through them. Default: 1. */
  minDelegates?: number;
  /**
   * Never fall back to direct probing when too few delegates are connected —
   * skip the round instead. Default: false (fall back to direct probing).
   */
  requireDelegates?: boolean;
}

export interface VerifierUpstreamConfig {
  /** OpenAI-compatible base URL, e.g. "https://openrouter.ai/api/v1". */
  baseUrl: string;
  /** API key sent as a Bearer token. Prefer apiKeyEnv over inlining secrets. */
  apiKey?: string;
  /** Environment variable to read the API key from (wins over apiKey). */
  apiKeyEnv?: string;
  /**
   * Map network service id → upstream model id when the names differ. Keys
   * are matched case-insensitively, so both the normalized service id
   * ("qwen/qwen3-32b") and the advertised spelling ("Qwen/Qwen3-32B") work.
   * Without an entry, the advertised spelling is sent to the upstream as-is.
   */
  modelMap?: Record<string, string>;
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
