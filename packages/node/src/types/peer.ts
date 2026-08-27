import type { PeerMetadata } from "../discovery/peer-metadata.js";
import type { DomainVerificationResult } from "../discovery/domain-verification.js";
import type { GithubVerificationResult } from "../discovery/github-verification.js";

// PeerId primitives moved to @antseed/protocol.
export { toPeerId, peerIdToAddress, type PeerId } from '@antseed/protocol/peer-id';
import type { PeerId } from '@antseed/protocol/peer-id';

export type { TokenPricingUsdPerMillion } from '@antseed/protocol/peer-metadata';
export type {
  ProviderPricingMatrixEntry,
  ProviderServiceCategoryMatrixEntry,
  ProviderServiceApiProtocolMatrixEntry,
  ProviderServiceUnitBillingModelMatrixEntry,
  ProviderServiceCapabilityMatrixEntry,
} from '@antseed/protocol/peer-pricing';
import type {
  ProviderPricingMatrixEntry,
  ProviderServiceCategoryMatrixEntry,
  ProviderServiceApiProtocolMatrixEntry,
  ProviderServiceUnitBillingModelMatrixEntry,
  ProviderServiceCapabilityMatrixEntry,
} from '@antseed/protocol/peer-pricing';

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
  /** Provider/service/protocol unit billing models announced by seller. */
  providerServiceUnitBillingModels?: Record<string, ProviderServiceUnitBillingModelMatrixEntry>;
  /** Provider/service model capability hints announced by seller. */
  providerServiceCapabilities?: Record<string, ProviderServiceCapabilityMatrixEntry>;
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
  /** Effective on-chain seller address resolved and verified for payment flows. */
  onChainSellerAddress?: string;
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
   * Model-verification reputation from AntseedVerification, keyed by
   * normalized service/model id. Populated only when the node is configured
   * with a verification contract address and the peer has an on-chain agent id.
   */
  modelVerification?: Record<string, PeerModelVerification>;
  /**
   * When `modelVerification` was last read from the verification contract (epoch ms).
   * Stamped by enrichment; consumers age a substitution flag out past
   * `MODEL_VERIFICATION_MAX_AGE_MS` so a peer retained after enrichment
   * stops updating (registry unconfigured, RPC down) is not blocked forever
   * on a flag that can no longer lift. Absent on entries set before stamping
   * existed — treated as no age information (flag honored).
   */
  modelVerificationFetchedAt?: number;
}

export type PeerVerificationLifecycle =
  | 'bootstrap'
  | 'provisional'
  | 'verified'
  | 'flagged'
  | 'suspended';

/** Buyer-computed verification lifecycle for one service. */
export interface PeerModelVerification {
  /** Keccak-256 hash of the normalized service identifier. */
  serviceHash: string;
  /** Lifecycle derived from active distinct-verifier state plus event metadata. */
  lifecycle: PeerVerificationLifecycle;
  /** Total SAME attestations observed for this service. */
  sameCount: number;
  /** Total conclusive DIFF attestations observed for this service. */
  diffCount: number;
  /** Total availability-only UNDETERMINED attestations observed. */
  undeterminedCount: number;
  /** Active distinct verifiers whose latest verdict for this service is DIFF. */
  activeDiffVerifierCount: number;
  /** Corroboration threshold configured on the verification points-policy adapter. */
  requiredDiffVerifierCount: number;
  /** Whether the adapter is currently registered in the points-policy registry. */
  enforcementActive: boolean;
  /** Compatibility alias for activeDiffVerifierCount. */
  consecutiveDiffCount: number;
  /** Latest on-chain verdict, including UNDETERMINED. */
  lastVerdict: number;
  /** Latest conclusive SAME or DIFF verdict; UNDETERMINED never changes it. */
  lastConclusiveVerdict: number;
  latestAuditId: string;
  latestEvidenceHash: string;
  latestVerifier: string;
  latestBlockNumber: number;
  /** Evidence metadata from the latest still-active DIFF verdict. */
  modelShareBps: number;
}
