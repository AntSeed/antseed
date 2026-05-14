import type { ServiceApiProtocol } from "./service-api.js";
import type { PeerMetadata } from "../discovery/peer-metadata.js";

/**
 * A PeerId is the EVM address hex (40 lowercase chars = 20 bytes, no 0x prefix).
 * This is the canonical identifier for any peer in the network.
 * The peer's secp256k1 wallet address serves as both P2P and on-chain identity.
 */
export type PeerId = string & { readonly __brand: "PeerId" };

/**
 * Validates and brands a string as a PeerId.
 * Must be exactly 40 lowercase hex characters (EVM address without 0x).
 */
export function toPeerId(hex: string): PeerId {
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`Invalid PeerId: expected 40 hex chars, got "${hex.slice(0, 20)}..."`);
  }
  return hex as PeerId;
}

/** Convert a PeerId to a checksummed 0x-prefixed EVM address. */
export function peerIdToAddress(peerId: string): string {
  return '0x' + peerId;
}

export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
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
  /** Unique peer identifier (EVM address, 40 hex chars). */
  peerId: PeerId;
  /** Human-readable label, optional. */
  displayName?: string;
  /** Last known STUN-resolved public address. */
  publicAddress?: string;
  /** Last seen timestamp (Unix ms). */
  lastSeen: number;
  /**
   * Last timestamp (Unix ms) at which the buyer successfully reached this peer
   * over the transport (e.g. a completed request). Decoupled from `lastSeen`,
   * which reflects DHT announcements, so a peer known to be alive survives
   * transient DHT staleness.
   */
  lastReachedAt?: number;
  /** LLM providers this peer is offering (empty if buyer-only). */
  providers: string[];
  /** Seller-reported reputation score (0-100). */
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
  /** Deterministic fallback default cached input price (USD per 1M tokens). */
  defaultCachedInputUsdPerMillion?: number;
  /** Maximum concurrent requests the peer can handle. */
  maxConcurrency?: number;
  /** Current number of requests the peer is handling. */
  currentLoad?: number;
  /**
   * On-chain ERC-8004 agent ID from `AntseedStaking.getAgentId`.
   * Read by the buyer directly from the chain.
   */
  onChainAgentId?: number;
  /**
   * On-chain seller stake in micro-USDC from `AntseedStaking.getStake`.
   * Read by the buyer directly from the chain.
   */
  onChainStakeUsdcMicros?: number;
  /** Buyer-computed displayed on-chain score (0-100). */
  onChainReputationScore?: number;
  /** Raw trust: channels × volume × ticket × recency × stake. */
  onChainTrustScore?: number;
  /** Sybil-risk heuristic in [0, 1]. */
  onChainSybilRisk?: number;
  /** Sybil signals that fired for this peer. */
  onChainSybilFlags?: string[];
  /** Settled channel count; buyer overwrites metadata with chain reads when available. */
  onChainChannelCount?: number;
  /** Ghost count; buyer overwrites metadata with chain reads when available. */
  onChainGhostCount?: number;
  /** Cumulative settled volume in micro-USDC. */
  onChainTotalVolumeUsdcMicros?: number;
  /** Unix seconds of the most recent settlement. */
  onChainLastSettledAtSec?: number;
  /** Unix seconds when the seller first staked. */
  onChainStakedAtSec?: number;
  /**
   * Unix ms when the buyer last refreshed on-chain stats for this peer.
   * Used to throttle repeat `getAgentStats` calls across discovery cycles.
   */
  onChainStatsFetchedAt?: number;
  /** Full peer metadata, if available (set after metadata resolution). */
  metadata?: PeerMetadata;
}
