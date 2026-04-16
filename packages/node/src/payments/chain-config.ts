import type { ChainId } from './types.js';

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
  stakingContractAddress?: string;
  usdcContractAddress: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  subPoolContractAddress?: string;
  /** Block when Channels contract was deployed. Floor for event log scans. */
  channelsDeployBlock?: number;
  /** AntseedStats contract address. Populated only where an indexer aggregates it. */
  statsContractAddress?: string;
  /** Deployment block of AntseedStats for cold-start indexer backfill. */
  statsDeployBlock?: number;
  /** Public URL of the @antseed/network-stats aggregator that indexes the stats contract for this chain. */
  networkStatsUrl?: string;
}

/**
 * Official contract addresses per chain.
 * These are the protocol defaults — users only need to override
 * if they want to point at a different chain (e.g. testnet).
 */
const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  'base-mainnet': {
    chainId: 'base-mainnet',
    evmChainId: 8453,
    rpcUrl: 'https://base.publicnode.com',
    fallbackRpcUrls: [
      'https://base.drpc.org',
      'https://base.llamarpc.com',
      'https://mainnet.base.org',
    ],
    usdcContractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    depositsContractAddress: '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2',
    channelsContractAddress: '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d',
    stakingContractAddress: '0x3652E6B22919bd322A25723B94BB207602E5c8e6',
    emissionsContractAddress: '0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5',
    identityRegistryAddress: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    channelsDeployBlock: 44469557,
    statsContractAddress: '0x15649ff076bfa5e37e24ee3154a00503149954fd',
    statsDeployBlock: 44469557,
    networkStatsUrl: 'https://network.antseed.com',
  },
  'base-sepolia': {
    chainId: 'base-sepolia',
    evmChainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdcContractAddress: '0xcA04797CaB6B412Cee6798B7314a05AdFDc3Cf23',
    depositsContractAddress: '0x96f083A9801AFdcE7D764651954A1A9Fbd489FEA',
    channelsContractAddress: '0x3b0b94AC27C042CAC17103A897Fb5cEb7D8b4cf7',
    stakingContractAddress: '0x1CB76B197a20E41f9AA01806B41C59e16Cad46a7',
    emissionsContractAddress: '0x9B30DAcfC20F0927fFD49fB0B84cf3EB83976a33',
    identityRegistryAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  'base-local': {
    chainId: 'base-local',
    evmChainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    // Nonce sequence: 0=USDC, 1=Registry, 2=ANTSToken, 3=AntseedRegistry, 4=Staking, 5=Deposits, 6=Channels, 7=Emissions, 8=SubPool
    usdcContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    identityRegistryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    stakingContractAddress: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    depositsContractAddress: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    channelsContractAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
    emissionsContractAddress: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
    subPoolContractAddress: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
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
  stakingContractAddress?: string;
  usdcContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  subPoolContractAddress?: string;
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
    ...(overrides?.stakingContractAddress ? { stakingContractAddress: overrides.stakingContractAddress } : {}),
    ...(overrides?.usdcContractAddress ? { usdcContractAddress: overrides.usdcContractAddress } : {}),
    ...(overrides?.identityRegistryAddress ? { identityRegistryAddress: overrides.identityRegistryAddress } : {}),
    ...(overrides?.emissionsContractAddress ? { emissionsContractAddress: overrides.emissionsContractAddress } : {}),
    ...(overrides?.subPoolContractAddress ? { subPoolContractAddress: overrides.subPoolContractAddress } : {}),
  };
}

export { DEFAULT_CHAIN_ID, CHAIN_CONFIGS };
