import { loadOrCreateIdentity, identityToEvmWallet, identityToEvmAddress } from '@antseed/node';
import type { Identity } from '@antseed/node';
import type { Wallet } from 'ethers';

export interface CryptoContext {
  identity: Identity;
  wallet: Wallet;
  evmAddress: string;
}

export interface PaymentCryptoConfig {
  rpcUrl: string;
  depositsContractAddress: string;
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
    // Desktop passes the decrypted identity hex via env var
    const { hexToBytes, bytesToHex } = await import('@antseed/node');
    const ed = await import('@noble/ed25519');
    const { sha512 } = await import('@noble/hashes/sha512');
    ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
    const privateKey = hexToBytes(options.identityHex);
    const publicKey = ed.getPublicKey(privateKey);
    const peerId = bytesToHex(publicKey) as Identity['peerId'];
    identity = { peerId, privateKey, publicKey };
  } else {
    const { homedir } = await import('node:os');
    const dataDir = options.dataDir || `${homedir()}/.antseed`;
    identity = await loadOrCreateIdentity(dataDir);
  }

  const wallet = identityToEvmWallet(identity);
  const evmAddress = identityToEvmAddress(identity);
  return { identity, wallet, evmAddress };
}
