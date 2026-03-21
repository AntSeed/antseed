import type { ChainId } from './types.js';

export interface ChainConfig {
  chainId: ChainId;
  evmChainId: number;
  rpcUrl: string;
  escrowContractAddress: string;
  usdcContractAddress: string;
  identityContractAddress?: string;
  emissionsContractAddress?: string;
  subPoolContractAddress?: string;
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
    escrowContractAddress: '0x0000000000000000000000000000000000000000', // TODO: deploy and fill
    usdcContractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  },
  'base-sepolia': {
    chainId: 'base-sepolia',
    evmChainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    escrowContractAddress: '0x0000000000000000000000000000000000000000', // TODO: deploy and fill
    usdcContractAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
  },
  'base-local': {
    chainId: 'base-local',
    evmChainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    escrowContractAddress: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    usdcContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    identityContractAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    emissionsContractAddress: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    subPoolContractAddress: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  },
};

const DEFAULT_CHAIN_ID: ChainId = 'base-mainnet';

/**
 * Get the chain config for a given chain ID.
 * Falls back to base-mainnet if not found.
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
  escrowContractAddress?: string;
  usdcContractAddress?: string;
  identityContractAddress?: string;
  emissionsContractAddress?: string;
  subPoolContractAddress?: string;
}): ChainConfig {
  const base = getChainConfig(overrides?.chainId);
  return {
    ...base,
    ...(overrides?.rpcUrl ? { rpcUrl: overrides.rpcUrl } : {}),
    ...(overrides?.escrowContractAddress ? { escrowContractAddress: overrides.escrowContractAddress } : {}),
    ...(overrides?.usdcContractAddress ? { usdcContractAddress: overrides.usdcContractAddress } : {}),
    ...(overrides?.identityContractAddress ? { identityContractAddress: overrides.identityContractAddress } : {}),
    ...(overrides?.emissionsContractAddress ? { emissionsContractAddress: overrides.emissionsContractAddress } : {}),
    ...(overrides?.subPoolContractAddress ? { subPoolContractAddress: overrides.subPoolContractAddress } : {}),
  };
}

export { DEFAULT_CHAIN_ID, CHAIN_CONFIGS };
