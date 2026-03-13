import type { AntseedConfig } from './types.js';

/**
 * Create a default Antseed configuration with sensible defaults.
 */
export function createDefaultConfig(): AntseedConfig {
  return {
    identity: {
      displayName: 'Antseed Node',
    },
    providers: [],
    seller: {
      reserveFloor: 10,
      maxConcurrentBuyers: 5,
      enabledProviders: [],
      pricing: {
        defaults: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
        },
      },
      publicAddress: '',
    },
    buyer: {
      preferredProviders: ['anthropic', 'openai', 'claude-code', 'claude-oauth', 'local-llm'],
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
      crypto: {
        chainId: 'base-local',
        rpcUrl: 'http://127.0.0.1:8545',
        escrowContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        usdcContractAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        defaultLockAmountUSDC: '1',
      },
    },
    network: {
      bootstrapNodes: [],
    },
  };
}
