import type { ServiceApiProtocol } from "./service-api.js";

/**
 * A PeerId is the hex-encoded Ed25519 public key (64 hex chars = 32 bytes).
 * This is the canonical identifier for any peer in the network.
 */
export type PeerId = string & { readonly __brand: "PeerId" };

/**
 * Validates and brands a string as a PeerId.
 * Must be exactly 64 lowercase hex characters.
 */
export function toPeerId(hex: string): PeerId {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Invalid PeerId: expected 64 hex chars, got "${hex.slice(0, 20)}..."`);
  }
  return hex as PeerId;
}

export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ProviderPricingMatrixEntry {
  defaults: TokenPricingUsdPerMillion;
  services?: Record<string, TokenPricingUsdPerMillion>;
}

export interface ProviderServiceCategoryMatrixEntry {
  services: Record<string, string[]>;
}

export interface ProviderServiceApiProtocolMatrixEntry {
  services: Record<string, ServiceApiProtocol[]>;
}

/** Information about a known peer. */
export interface PeerInfo {
  /** Unique peer identifier (Ed25519 public key hex). */
  peerId: PeerId;
  /** Human-readable label, optional. */
  displayName?: string;
  /** Last known STUN-resolved public address. */
  publicAddress?: string;
  /** Last seen timestamp (Unix ms). */
  lastSeen: number;
  /** LLM providers this peer is offering (empty if buyer-only). */
  providers: string[];
  /** Reputation score (0-100). */
  reputationScore?: number;
  /** Provider/service-aware pricing map announced by seller. */
  providerPricing?: Record<string, ProviderPricingMatrixEntry>;
  /** Provider/service category tags announced by seller. */
  providerServiceCategories?: Record<string, ProviderServiceCategoryMatrixEntry>;
  /** Provider/service API protocols announced by seller. */
  providerServiceApiProtocols?: Record<string, ProviderServiceApiProtocolMatrixEntry>;
  /** Deterministic fallback default input price (USD per 1M tokens). */
  defaultInputUsdPerMillion?: number;
  /** Deterministic fallback default output price (USD per 1M tokens). */
  defaultOutputUsdPerMillion?: number;
  /** Maximum concurrent requests the peer can handle. */
  maxConcurrency?: number;
  /** Current number of requests the peer is handling. */
  currentLoad?: number;
  /** Computed trust score (0-100) from the trust engine. */
  trustScore?: number;
  /** EVM address of the peer (0x-prefixed hex). */
  evmAddress?: string;
  /** On-chain reputation score (0-100) from the Base identity contract. */
  onChainReputation?: number;
  /** On-chain session count from the Base identity contract. */
  onChainSessionCount?: number;
  /** On-chain dispute count from the Base identity contract. */
  onChainDisputeCount?: number;
}
