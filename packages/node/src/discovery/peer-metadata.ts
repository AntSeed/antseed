import type { PeerId } from "../types/peer.js";
import type { PeerOffering } from "../types/capability.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import type { ServiceUnitBillingModelsV1 } from "../types/billing.js";
import { WELL_KNOWN_SERVICE_API_PROTOCOLS } from "../types/service-api.js";

export const METADATA_VERSION = 10;
export const SERVICE_UNIT_BILLING_METADATA_VERSION = 11;
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

export interface ProviderAnnouncement {
  provider: string;
  services: string[];
  defaultPricing: TokenPricingUsdPerMillion;
  servicePricing?: Record<string, TokenPricingUsdPerMillion>;
  serviceCategories?: Record<string, string[]>;
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  serviceUnitBillingModels?: ServiceUnitBillingModelsV1;
  maxConcurrency: number;
  currentLoad: number;
}

export type DomainVerificationMethod = "dns-txt" | "https-well-known";

export interface DomainVerificationClaim {
  /** ASCII hostname only, lower-case, with no scheme, path, or port. */
  domain: string;
  /** Accepted proof transports. When omitted, clients may try every known method. */
  methods?: DomainVerificationMethod[];
}

export interface GithubVerificationClaim {
  /** GitHub username, lower-case. */
  username: string;
  /**
   * Public repository holding the proof file, lower-case. Defaults to the
   * profile repository `<username>/<username>` when omitted.
   */
  repository?: string;
}

export interface PeerVerifications {
  /**
   * Domain ownership claims. Clients verify by checking a matching DNS TXT
   * record at `_antseed.<domain>` or a well-known proof at
   * `https://<domain>/.well-known/antseed.json`.
   */
  domains?: DomainVerificationClaim[];
  /**
   * GitHub account ownership claims. Clients verify by fetching
   * `https://raw.githubusercontent.com/<username>/<repository>/HEAD/antseed.json`
   * — the username in the URL path binds the proof to the account.
   */
  github?: GithubVerificationClaim[];
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
  onChainChannelCount?: number;
  onChainGhostCount?: number;
  /** Protocol capabilities supported by this peer. */
  capabilities?: string[];
  /**
   * On-chain seller contract that fronts this peer (e.g. a DiemStakingProxy).
   * Buyers resolve `seller = sellerContract` for channel flows and verify the
   * binding by calling `sellerContract.isOperator(peerAddress)` on-chain.
   * Stored as 40 lowercase hex chars (no `0x` prefix) matching `peerId` format.
   */
  sellerContract?: string;
  /** Optional external ownership claims announced by this peer. */
  verifications?: PeerVerifications;
  /**
   * Buyer-local observation time for this metadata fetch. Not signed and not
   * encoded in metadata; used only for diagnostics/freshness decisions.
   */
  resolvedAtMs?: number;
  /**
   * Seller HTTP Date header observed during metadata fetch, in Unix ms. Not
   * signed and not encoded in metadata. When present, buyers can judge the
   * signed timestamp using the seller's wall clock instead of their own, which
   * keeps discovery working for users whose local desktop clock is wrong.
   */
  serverDateMs?: number;
  signature: string;
}
