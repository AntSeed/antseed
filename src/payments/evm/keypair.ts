import { Wallet, keccak256 } from 'ethers';
import type { Identity } from '../../p2p/identity.js';

/**
 * Derive a secp256k1 private key from the Ed25519 identity seed.
 * Domain-separated to ensure the derived key is independent from the Ed25519 key.
 *
 * Derivation: keccak256(ed25519_seed || "evm-payment-key") → secp256k1 private key
 *
 * The Ed25519 seed (identity.privateKey) is 32 bytes. We append a fixed
 * domain separator string to prevent the derived key from colliding with
 * any other use of the same seed. keccak256 produces a 32-byte output
 * which is a valid secp256k1 private key (the probability of hitting an
 * invalid key is astronomically low: ~1/2^128).
 */
export function identityToEvmWallet(identity: Identity): Wallet {
  const domainSeparator = new TextEncoder().encode('evm-payment-key');
  const combined = new Uint8Array(identity.privateKey.length + domainSeparator.length);
  combined.set(identity.privateKey, 0);
  combined.set(domainSeparator, identity.privateKey.length);
  const privateKey = keccak256(combined);
  return new Wallet(privateKey);
}

/**
 * Get the EVM address (0x-prefixed hex) for a Antseed Identity.
 * This is the address that appears on-chain as the buyer or seller.
 */
export function identityToEvmAddress(identity: Identity): string {
  return identityToEvmWallet(identity).address;
}
