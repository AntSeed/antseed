import type { ServiceApiProtocol } from "./service-api.js";
import type { PeerMetadata } from "../discovery/peer-metadata.js";
import type { DomainVerificationResult } from "../discovery/domain-verification.js";
import type { GithubVerificationResult } from "../discovery/github-verification.js";

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

export interface PeerVerificationResults {
  /** True when every announced external claim verified successfully. */
  verified: boolean;
  /** Buyer-local time when the latest verification pass completed. */
  checkedAtMs: number;
  /** Domain ownership verification results, one per announced domain claim. */
  domains: DomainVerificationResult[];
  /** GitHub account ownership verification results, one per announced GitHub claim. */
  github: GithubVerificationResult[];
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
  /** Protocol capabilities announced by the peer. */
  capabilities?: string[];
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
  /** Raw on-chain trust: credited settled USDC volume. */
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
  /** Buyer-computed results for external ownership claims announced in metadata. */
  verificationResults?: PeerVerificationResults;
  /**
   * Model-verification reputation from the AntseedVerifierRegistry, keyed by
   * normalized service/model id. Populated only when the node is configured
   * with a verifier registry address and the peer has an on-chain agent id.
   */
  modelVerification?: Record<string, PeerModelVerification>;
}

/** Buyer-computed model-verification reputation for one (peer, model). */
export interface PeerModelVerification {
  /** SAME attestations recorded on-chain for this (agent, service). */
  sameCount: number;
  /** DIFF (substitution-flag) attestations. */
  diffCount: number;
  /** UNDETERMINED attestations. */
  undeterminedCount: number;
  /** Distinct approved verifiers that attested this (agent, service). */
  distinctVerifierCount: number;
  /**
   * Distinct verifiers whose LATEST verdict is DIFF — a standing, retractable
   * accusation (a verifier retracts by later attesting SAME), unlike the
   * monotonic historical `diffCount`. This is the field routing decisions
   * gate on, mirroring the on-chain points penalty.
   */
  activeDiffVerifierCount: number;
  /** Latest on-chain verdict code (0 unknown, 1 same, 2 diff, 3 undetermined). */
  lastVerdict: number;
  /**
   * Buyer-computed confidence score in [0,100] that the model is authentic,
   * or null when there is no usable evidence (no attestations / single
   * verifier only). Never fabricated — reflects only recorded attestations.
   */
  score: number | null;
  /**
   * Effective `AntseedVerifierPointsPolicy.minDistinctDiffVerifiers` at
   * enrichment time — the number of distinct standing-DIFF verifiers at which
   * the on-chain economic penalty triggers, read from chain (TTL-cached) and
   * stamped here so routing exclusion (`hasModelSubstitutionFlag`) fires at
   * the same bar. Absent when the value could not be determined at enrichment
   * (consumers then fall back to MIN_DISTINCT_DIFF_VERIFIERS_FOR_EXCLUSION).
   */
  exclusionThreshold?: number;
}
