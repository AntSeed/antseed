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
  registryContractAddress?: string;
  /** Optional AntseedFreeUsage contract address for zero-price signed usage. */
  freeUsageContractAddress?: string;
  stakingContractAddress?: string;
  usdcContractAddress: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  antsTokenAddress?: string;
  emissionsGateAddress?: string;
  sellerPoolsAddress?: string;
  sellerRegistryAddress?: string;
  positionInitAddress?: string;
  usageAccountingAddress?: string;
  usageRewardsAddress?: string;
  sellerPoolsRewardsAddress?: string;
  legacyEmissionsEscrowAddress?: string;
  /** Block when Channels contract was deployed. Floor for event log scans. */
  channelsDeployBlock?: number;
  /** AntseedStats contract address. Populated only where an indexer aggregates it. */
  statsContractAddress?: string;
  /** Deployment block of AntseedStats for cold-start indexer backfill. */
  statsDeployBlock?: number;
  /** Public URL of the @antseed/network-stats aggregator that indexes the stats contract for this chain. */
  networkStatsUrl?: string;
  /** Public REST API of the chain explorer (Antscan). Serves per-seller on-chain stats at /api/sellers. */
  explorerApiUrl?: string;
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
    // Benchmarked 2026-08-10 (3-concurrent eth_call, archive-depth support):
    //   tenderly — ~150ms, 9/9 reliable, serves archive calls (primary)
    //   drpc     — ~175ms, 9/9 reliable, serves archive calls
    //   nodies   — ~270ms, 9/9 reliable, serves archive calls
    //   mainnet.base.org — flaky under concurrent reads (last resort)
    // Explicitly NOT listed:
    //   publicnode — 403s archive-depth requests ("Archive requests require a
    //     personal token"); FallbackProvider treats the JSON-RPC error body as
    //     a valid result (indistinguishable from a revert), so with quorum=1
    //     the 403 poisons the whole call instead of failing over.
    //   llamarpc — down (521) and returns missing revert data on concurrent reads.
    rpcUrl: 'https://base.gateway.tenderly.co',
    fallbackRpcUrls: [
      'https://base.drpc.org',
      'https://base-public.nodies.app',
      'https://mainnet.base.org',
    ],
    networkStatsUrl: 'https://network.antseed.com',
    explorerApiUrl: 'https://antscan.co',
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
    registryContractAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
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
  registryContractAddress?: string;
  freeUsageContractAddress?: string;
  stakingContractAddress?: string;
  usdcContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  antsTokenAddress?: string;
  emissionsGateAddress?: string;
  sellerPoolsAddress?: string;
  sellerRegistryAddress?: string;
  positionInitAddress?: string;
  usageAccountingAddress?: string;
  usageRewardsAddress?: string;
  sellerPoolsRewardsAddress?: string;
  legacyEmissionsEscrowAddress?: string;
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
    ...(overrides?.registryContractAddress ? { registryContractAddress: overrides.registryContractAddress } : {}),
    ...(overrides?.freeUsageContractAddress ? { freeUsageContractAddress: overrides.freeUsageContractAddress } : {}),
    ...(overrides?.stakingContractAddress ? { stakingContractAddress: overrides.stakingContractAddress } : {}),
    ...(overrides?.usdcContractAddress ? { usdcContractAddress: overrides.usdcContractAddress } : {}),
    ...(overrides?.identityRegistryAddress ? { identityRegistryAddress: overrides.identityRegistryAddress } : {}),
    ...(overrides?.emissionsContractAddress ? { emissionsContractAddress: overrides.emissionsContractAddress } : {}),
    ...(overrides?.legacyEmissionsContractAddress ? { legacyEmissionsContractAddress: overrides.legacyEmissionsContractAddress } : {}),
    ...(overrides?.legacyStakingContractAddress ? { legacyStakingContractAddress: overrides.legacyStakingContractAddress } : {}),
    ...(overrides?.legacyEmissionsV1ContractAddress ? { legacyEmissionsV1ContractAddress: overrides.legacyEmissionsV1ContractAddress } : {}),
    ...(overrides?.antsTokenAddress ? { antsTokenAddress: overrides.antsTokenAddress } : {}),
    ...(overrides?.emissionsGateAddress ? { emissionsGateAddress: overrides.emissionsGateAddress } : {}),
    ...(overrides?.sellerPoolsAddress ? { sellerPoolsAddress: overrides.sellerPoolsAddress } : {}),
    ...(overrides?.sellerRegistryAddress ? { sellerRegistryAddress: overrides.sellerRegistryAddress } : {}),
    ...(overrides?.positionInitAddress ? { positionInitAddress: overrides.positionInitAddress } : {}),
    ...(overrides?.usageAccountingAddress ? { usageAccountingAddress: overrides.usageAccountingAddress } : {}),
    ...(overrides?.usageRewardsAddress ? { usageRewardsAddress: overrides.usageRewardsAddress } : {}),
    ...(overrides?.sellerPoolsRewardsAddress ? { sellerPoolsRewardsAddress: overrides.sellerPoolsRewardsAddress } : {}),
    ...(overrides?.legacyEmissionsEscrowAddress ? { legacyEmissionsEscrowAddress: overrides.legacyEmissionsEscrowAddress } : {}),
    ...(overrides?.depositRelayAddress ? { depositRelayAddress: overrides.depositRelayAddress } : {}),
  };
}

export { DEFAULT_CHAIN_ID, CHAIN_CONFIGS };
