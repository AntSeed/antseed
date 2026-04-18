import type { PeerId } from "../types/peer.js";
import type { PeerOffering } from "../types/capability.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import { WELL_KNOWN_SERVICE_API_PROTOCOLS } from "../types/service-api.js";

export const METADATA_VERSION = 8;
export const WELL_KNOWN_SERVICE_CATEGORIES = [
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
  cachedInputUsdPerMillion?: number;
}

/**
 * Off-chain attestation published by peers whose on-chain seller is a smart
 * contract (e.g., DiemStakingProxy). Signed by the proxy's operator EOA via
 * EIP-712 (domain: DiemStakingProxy v1). Buyers verify the signer matches
 * the current `operator()` on the proxy contract before resolving
 * `seller = sellerContract` for channel flows.
 */
export interface SellerDelegationPayload {
  /** The peer's EVM address (equal to peerId with 0x prefix). */
  peerAddress: string;
  /** The on-chain seller contract (also the proxy contract the buyer queries). */
  sellerContract: string;
  /** EVM chainId this delegation is valid on. */
  chainId: number;
  /** Unix seconds. Buyers reject delegations past expiry. */
  expiresAt: number;
  /** secp256k1 65-byte signature (hex, no 0x) over the EIP-712 digest. */
  signature: string;
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
  publicAddress?: string;
  providers: ProviderAnnouncement[];
  offerings?: PeerOffering[];
  region: string;
  timestamp: number;
  stakeAmountUSDC?: number;
  trustScore?: number;
  onChainChannelCount?: number;
  onChainGhostCount?: number;
  sellerDelegation?: SellerDelegationPayload;
  signature: string;
}
