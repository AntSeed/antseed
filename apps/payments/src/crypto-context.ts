import { loadOrCreateIdentity, identityFromPrivateKeyHex } from '@antseed/node';
import type { Identity } from '@antseed/node';
import type { Wallet } from 'ethers';

export interface CryptoContext {
  identity: Identity;
  wallet: Wallet;
  evmAddress: string;
}

export interface PaymentCryptoConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  depositsContractAddress: string;
  channelsContractAddress: string;
  usdcContractAddress: string;
}

/**
 * Load crypto context from either ANTSEED_IDENTITY_HEX env var
 * or from the data directory's identity file.
 */
export async function loadCryptoContext(options: {
  identityHex?: string;
  dataDir?: string;
}): Promise<CryptoContext> {
  let identity: Identity;

  if (options.identityHex) {
    identity = identityFromPrivateKeyHex(options.identityHex);
  } else {
    const { homedir } = await import('node:os');
    const dataDir = options.dataDir || `${homedir()}/.antseed`;
    identity = await loadOrCreateIdentity(dataDir);
  }

  return { identity, wallet: identity.wallet, evmAddress: identity.wallet.address };
}
