import type { AntseedConfig } from './types.js';

/**
 * Create a default Antseed configuration with sensible defaults.
 */
export function createDefaultConfig(): AntseedConfig {
  return {
    identity: {
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
      minPeerReputation: 50,
      proxyPort: 8377,
    },
    payments: {
      preferredMethod: 'crypto',
      platformFeeRate: 0.05,
    },
    network: {
      bootstrapNodes: [],
    },
  };
}
