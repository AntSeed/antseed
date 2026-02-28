import type { PeerId } from "../types/peer.js";
import type { PeerOffering } from "../types/capability.js";
import type { ModelApiProtocol } from "../types/model-api.js";
import { WELL_KNOWN_MODEL_API_PROTOCOLS } from "../types/model-api.js";

export const METADATA_VERSION = 4;
export const WELL_KNOWN_MODEL_CATEGORIES = [
  "privacy",
  "legal",
  "uncensored",
  "coding",
  "finance",
  "tee",
] as const;
export { WELL_KNOWN_MODEL_API_PROTOCOLS };
export type { ModelApiProtocol };

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
  modelApiProtocols?: Record<string, ModelApiProtocol[]>;
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
  signature: string;
}
