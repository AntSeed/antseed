import type { AntseedConfig } from './types.js';

export const DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS = 1500;

/**
 * Create a default Antseed configuration with sensible defaults.
 */
export function createDefaultConfig(): AntseedConfig {
  return {
    identity: {
      // Replaced with a deterministic peer-derived name when the CLI creates
      // or loads an identity (for example, `antseed seller setup/start`).
      displayName: 'Antseed Node',
    },
    seller: {
      reserveFloor: 10,
      maxConcurrentBuyers: 5,
      providers: {},
      publicAddress: '',
    },
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 100,
          outputUsdPerMillion: 100,
        },
      },
      minPeerReputation: 0,
      proxyPort: 8377,
      peerRefreshIntervalMs: DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS,
      metadataFetchTimeoutMs: DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS,
      disableMetadataV2Services: false,
    },
    payments: {
      preferredMethod: 'crypto',
      platformFeeRate: 0.05,
      crypto: {
        chainId: 'base-mainnet',
      },
    },
    network: {
      bootstrapNodes: [],
    },
    verifier: {
      services: [],
      auditIntervalMs: 300_000,
      maxAuditsPerEpoch: 50,
      probeRequestTimeoutMs: 120_000,
      maxConcurrentProbeRequests: 2,
      referencePolicy: {
        minimumAuditProbeCount: 100,
        maximumAuditProbeCount: 750,
        auditProbeStep: 10,
        minimumStatisticalPower: 0.9,
        minimumMismatchDelta: 0.1,
        familyWideAlpha: 0.05,
        referenceConfidence: 0.99,
        minimumAuthenticatedCoverage: 1,
        maxReferenceAgeDays: 49,
        maxRequestsPerRound: 2000,
        requestTimeoutMs: 120_000,
        batchRetryCount: 3,
        generationDomainConcurrency: 3,
        maxConcurrentReferenceRequests: 4,
        maxConcurrentRequestsPerModel: 2,
      },
    },
  };
}
