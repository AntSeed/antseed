import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base, baseSepolia, hardhat } from 'wagmi/chains';

/**
 * Wagmi config for the payments portal.
 * Supports Base mainnet, Base Sepolia, and local Hardhat/Anvil.
 * The portal auto-detects the chain from /api/config and prompts the user
 * to switch if they're on the wrong network.
 */
export const wagmiConfig = getDefaultConfig({
  appName: 'AntSeed Payments',
  projectId: 'antseed-payments', // WalletConnect project ID (optional for local dev)
  chains: [base, baseSepolia, hardhat],
});
