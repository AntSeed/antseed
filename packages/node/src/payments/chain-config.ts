import type { ChainId } from './types.js';

export interface ChainConfig {
  chainId: ChainId;
  evmChainId: number;
  rpcUrl: string;
  depositsContractAddress: string;
  channelsContractAddress: string;
  stakingContractAddress?: string;
  usdcContractAddress: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  subPoolContractAddress?: string;
  /** Block when Channels contract was deployed. Floor for event log scans. */
  channelsDeployBlock?: number;
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
    rpcUrl: 'https://mainnet.base.org',
    depositsContractAddress: '0x0000000000000000000000000000000000000000', // TODO: deploy and fill
    channelsContractAddress: '0x0000000000000000000000000000000000000000', // TODO: deploy and fill
    usdcContractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  },
  'base-sepolia': {
    chainId: 'base-sepolia',
    evmChainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdcContractAddress: '0xC30D7A4c83C58d90127cd4e41D4CCdaAfcF0b1d6',
    depositsContractAddress: '0xd07527ea463E5ddE62c2f30B695225B4D95Fd091',
    channelsContractAddress: '0xcBfd529c3a45c9Dd168f9d53a2BFFCe7e8F7E64f',
    stakingContractAddress: '0xd42e9D274bd187D310D6fDDF1a4f343DCd018B14',
    emissionsContractAddress: '0xB55241dd24fC1f9fe7C686979b52E84fd63F7f30',
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

const DEFAULT_CHAIN_ID: ChainId = 'base-sepolia';

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
  depositsContractAddress?: string;
  channelsContractAddress?: string;
  stakingContractAddress?: string;
  usdcContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  subPoolContractAddress?: string;
}): ChainConfig {
  const base = getChainConfig(overrides?.chainId);
  return {
    ...base,
    ...(overrides?.rpcUrl ? { rpcUrl: overrides.rpcUrl } : {}),
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
