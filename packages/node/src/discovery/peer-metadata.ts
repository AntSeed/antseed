import type { PeerId } from "../types/peer.js";
import type { PeerOffering } from "../types/capability.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import { WELL_KNOWN_SERVICE_API_PROTOCOLS } from "../types/service-api.js";

export const METADATA_VERSION = 4;
export const WELL_KNOWN_MODEL_CATEGORIES = [
  "privacy",
  "legal",
  "uncensored",
  "coding",
  "finance",
  "tee",
] as const;
export { WELL_KNOWN_SERVICE_API_PROTOCOLS };
export type { ServiceApiProtocol };

export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ProviderAnnouncement {
  provider: string;
  services: string[];
  defaultPricing: TokenPricingUsdPerMillion;
  servicePricing?: Record<string, TokenPricingUsdPerMillion>;
  serviceCategories?: Record<string, string[]>;
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
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
