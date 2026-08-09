import type { PeerId } from "../types/peer.js";
import type { PeerOffering } from "../types/capability.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import type { ServiceUnitBillingModelsV1 } from "../types/billing.js";
import { WELL_KNOWN_SERVICE_API_PROTOCOLS } from "../types/service-api.js";

export const METADATA_VERSION = 12;
/** Oldest announced metadata version buyers still accept from sellers. */
export const MIN_SUPPORTED_METADATA_VERSION = 10;
export const SERVICE_UNIT_BILLING_METADATA_VERSION = 11;
export const SERVICE_CAPABILITIES_METADATA_VERSION = 12;
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

export const SERVICE_CAPABILITY_INPUTS = ["text", "image", "audio", "video", "pdf"] as const;
export type ServiceCapabilityInput = (typeof SERVICE_CAPABILITY_INPUTS)[number];

/**
 * Per-service model capability hints announced by sellers. Every field is
 * optional: absent means unknown, so buyers fall back to their own defaults.
 */
export interface ServiceCapabilities {
  /** Total context window in tokens. */
  contextWindow?: number;
  /** Maximum output tokens per response. */
  maxOutputTokens?: number;
  /** Supported input modalities. */
  inputs?: ServiceCapabilityInput[];
  /** Supports extended thinking / reasoning effort. */
  reasoning?: boolean;
  /** Supports tool use / function calling. */
  toolUse?: boolean;
  /** Supports structured output / JSON schema responses. */
  structuredOutput?: boolean;
}

/** Ceiling for announced contextWindow / maxOutputTokens (fits the u32 wire field). */
export const MAX_CAPABILITY_TOKEN_COUNT = 1_000_000_000;
const SERVICE_CAPABILITY_INPUT_SET = new Set<string>(SERVICE_CAPABILITY_INPUTS);

/**
 * Field-level validation for one service's capability entry. Shared by the
 * announce-time metadata validator and provider config parsing so the two
 * can never drift: anything config parsing accepts must also announce.
 */
export function validateServiceCapabilityFields(caps: ServiceCapabilities): string[] {
  const errors: string[] = [];
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const value = caps[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_CAPABILITY_TOKEN_COUNT) {
      errors.push(`${key} must be a positive integer <= ${MAX_CAPABILITY_TOKEN_COUNT}`);
    }
  }
  if (caps.inputs !== undefined) {
    if (!Array.isArray(caps.inputs)) {
      errors.push("inputs must be an array");
    } else {
      const seen = new Set<string>();
      for (const input of caps.inputs) {
        if (!SERVICE_CAPABILITY_INPUT_SET.has(input)) {
          errors.push(`Unsupported input modality "${input}"`);
        } else if (seen.has(input)) {
          errors.push(`Duplicate input modality "${input}"`);
        }
        seen.add(input);
      }
    }
  }
  for (const key of ["reasoning", "toolUse", "structuredOutput"] as const) {
    const value = caps[key];
    if (value !== undefined && typeof value !== "boolean") {
      errors.push(`${key} must be a boolean`);
    }
  }
  return errors;
}

export interface ProviderAnnouncement {
  provider: string;
  services: string[];
  defaultPricing: TokenPricingUsdPerMillion;
  servicePricing?: Record<string, TokenPricingUsdPerMillion>;
  serviceCategories?: Record<string, string[]>;
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  serviceUnitBillingModels?: ServiceUnitBillingModelsV1;
  serviceCapabilities?: Record<string, ServiceCapabilities>;
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
