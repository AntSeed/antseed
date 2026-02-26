import type { PeerId } from "../types/peer.js";
import type { PeerOffering } from "../types/capability.js";

export const METADATA_VERSION = 3;
export const WELL_KNOWN_MODEL_CATEGORIES = [
  "privacy",
  "legal",
  "uncensored",
  "coding",
  "finance",
  "tee",
] as const;

export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ProviderAnnouncement {
  provider: string;
  models: string[];
  defaultPricing: TokenPricingUsdPerMillion;
  modelPricing?: Record<string, TokenPricingUsdPerMillion>;
  modelCategories?: Record<string, string[]>;
  maxConcurrency: number;
  currentLoad: number;
}

export interface PeerMetadata {
  peerId: PeerId;
  version: number;
  displayName?: string;
  providers: ProviderAnnouncement[];
  offerings?: PeerOffering[];
  region: string;
  timestamp: number;
  stakeAmountUSDC?: number;
  trustScore?: number;
  evmAddress?: string;
  onChainReputation?: number;
  onChainSessionCount?: number;
  onChainDisputeCount?: number;
  signature: string;
}
