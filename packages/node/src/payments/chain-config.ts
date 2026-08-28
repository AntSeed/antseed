import type { ChainId } from './types.js';
import { DEPLOYED_CONTRACT_ADDRESSES } from './generated-contract-addresses.js';

export interface ChainConfig {
  chainId: ChainId;
  evmChainId: number;
  rpcUrl: string;
  /**
   * Additional RPC endpoints tried in order when the primary `rpcUrl` fails.
   * Wired into ethers `FallbackProvider` with quorum=1 so the first successful
   * response wins. Ordered by preference (first entry is highest priority
   * after the primary).
   */
  fallbackRpcUrls?: string[];
  depositsContractAddress: string;
  channelsContractAddress: string;
  /** Optional AntseedFreeUsage contract address for zero-price signed usage. */
  freeUsageContractAddress?: string;
  stakingContractAddress?: string;
  usdcContractAddress: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  antsTokenAddress?: string;
  /** Block when Channels contract was deployed. Floor for event log scans. */
  channelsDeployBlock?: number;
  /** AntseedStats contract address. Populated only where an indexer aggregates it. */
  statsContractAddress?: string;
  /** Deployment block of AntseedStats for cold-start indexer backfill. */
  statsDeployBlock?: number;
  /** Public URL of the @antseed/network-stats aggregator that indexes the stats contract for this chain. */
  networkStatsUrl?: string;
  /** AntseedDepositRelay contract for gasless USDC sweeps from buyer hot wallets. */
  depositRelayAddress?: string;
}

/**
 * Official contract addresses per chain.
 * These are the protocol defaults — users only need to override
 * if they want to point at a different chain (e.g. testnet).
 */
const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  'base-mainnet': {
    ...DEPLOYED_CONTRACT_ADDRESSES['base-mainnet'],
    chainId: 'base-mainnet',
    rpcUrl: 'https://base.publicnode.com',
    fallbackRpcUrls: [
      'https://base.drpc.org',
      'https://base.llamarpc.com',
      'https://mainnet.base.org',
    ],
    networkStatsUrl: 'https://network.antseed.com',
  },
  'base-sepolia': {
    ...DEPLOYED_CONTRACT_ADDRESSES['base-sepolia'],
    chainId: 'base-sepolia',
    rpcUrl: 'https://sepolia.base.org',
    // depositRelayAddress: TODO — set after AntseedDepositRelay sepolia deployment
  },
  'base-local': {
    chainId: 'base-local',
    evmChainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    // Nonce sequence: 0=USDC, 1=Registry, 2=ANTSToken, 3=AntseedRegistry, 4=Staking, 5=Deposits, 6=Channels, 7=Stats, 8=Emissions, 9=DepositRelay
    usdcContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    identityRegistryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    stakingContractAddress: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    depositsContractAddress: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    channelsContractAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
    emissionsContractAddress: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
    depositRelayAddress: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
  },
};

const DEFAULT_CHAIN_ID: ChainId = 'base-mainnet';

/**
 * Get the chain config for a given chain ID.
 * Falls back to base-sepolia if not found.
 */
export function getChainConfig(chainId?: ChainId | string): ChainConfig {
  if (!chainId) return CHAIN_CONFIGS[DEFAULT_CHAIN_ID];
  const config = CHAIN_CONFIGS[chainId as ChainId];
  return config ?? CHAIN_CONFIGS[DEFAULT_CHAIN_ID];
}

/**
 * Resolve a full chain config from user overrides.
 * User config values take precedence over protocol defaults.
 */
export function resolveChainConfig(overrides?: {
  chainId?: ChainId | string;
  rpcUrl?: string;
  fallbackRpcUrls?: string[];
  depositsContractAddress?: string;
  channelsContractAddress?: string;
  freeUsageContractAddress?: string;
  stakingContractAddress?: string;
  usdcContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  antsTokenAddress?: string;
  depositRelayAddress?: string;
}): ChainConfig {
  const base = getChainConfig(overrides?.chainId);
  // If the caller overrode the primary rpcUrl without providing their own
  // fallbacks, drop the defaults — they picked a specific endpoint, respect
  // that choice and don't silently route around it.
  const rpcOverridden = !!overrides?.rpcUrl;
  const resolvedFallbacks = overrides?.fallbackRpcUrls
    ?? (rpcOverridden ? [] : base.fallbackRpcUrls);
  return {
    ...base,
    ...(overrides?.rpcUrl ? { rpcUrl: overrides.rpcUrl } : {}),
    ...(resolvedFallbacks !== undefined ? { fallbackRpcUrls: resolvedFallbacks } : {}),
    ...(overrides?.depositsContractAddress ? { depositsContractAddress: overrides.depositsContractAddress } : {}),
    ...(overrides?.channelsContractAddress ? { channelsContractAddress: overrides.channelsContractAddress } : {}),
    ...(overrides?.freeUsageContractAddress ? { freeUsageContractAddress: overrides.freeUsageContractAddress } : {}),
    ...(overrides?.stakingContractAddress ? { stakingContractAddress: overrides.stakingContractAddress } : {}),
    ...(overrides?.usdcContractAddress ? { usdcContractAddress: overrides.usdcContractAddress } : {}),
    ...(overrides?.identityRegistryAddress ? { identityRegistryAddress: overrides.identityRegistryAddress } : {}),
    ...(overrides?.emissionsContractAddress ? { emissionsContractAddress: overrides.emissionsContractAddress } : {}),
    ...(overrides?.legacyEmissionsContractAddress ? { legacyEmissionsContractAddress: overrides.legacyEmissionsContractAddress } : {}),
    ...(overrides?.antsTokenAddress ? { antsTokenAddress: overrides.antsTokenAddress } : {}),
    ...(overrides?.depositRelayAddress ? { depositRelayAddress: overrides.depositRelayAddress } : {}),
  };
}

export { DEFAULT_CHAIN_ID, CHAIN_CONFIGS };
