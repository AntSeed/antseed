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
        depositsContractAddress: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
        channelsContractAddress: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
        usdcContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        identityRegistryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        statsContractAddress: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
        emissionsContractAddress: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
        subPoolContractAddress: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
        defaultLockAmountUSDC: '1',
      },
    },
    network: {
      bootstrapNodes: [],
    },
  };
}
