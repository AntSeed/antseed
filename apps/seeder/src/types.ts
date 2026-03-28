export interface SeederConfig {
  identity: {
    displayName: string;
    walletAddress?: string;
  };
  seller: {
    enabledProviders: string[];
    reserveFloor: number;
    maxConcurrentBuyers: number;
    pricing: HierarchicalPricingConfig;
  };
  buyer: {
    maxPricing: HierarchicalPricingConfig;
    minPeerReputation: number;
    proxyPort: number;
  };
  network: {
    bootstrapNodes: string[];
  };
  payments: {
    preferredMethod: string;
    platformFeeRate: number;
    crypto?: {
      chainId: string;
      rpcUrl: string;
      depositsContractAddress: string;
      usdcContractAddress: string;
      defaultLockAmountUSDC?: string;
    };
  };
  providers?: unknown[];
  plugins?: { name: string; package: string; installedAt: string }[];
}

export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ProviderPricingConfig {
  defaults?: TokenPricingUsdPerMillion;
  services?: Record<string, TokenPricingUsdPerMillion>;
}

export interface HierarchicalPricingConfig {
  defaults: TokenPricingUsdPerMillion;
  providers?: Record<string, ProviderPricingConfig>;
}

export interface NodeStatus {
  state: 'seeding' | 'connected' | 'idle';
  peerCount: number;
  earningsToday: string;
  tokensToday: number;
  activeSessions: number;
  uptime: string;
  walletAddress: string | null;
  proxyPort: number | null;
  capacityUsedPercent: number;
  daemonPid: number | null;
  daemonAlive: boolean;
}
